import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const NETWORK_NAME = "apps-internal"
// Compose projects Dragonify manages; TrueNAS names its apps' projects ix-*.
const PROJECT_MATCH = new RegExp(process.env.PROJECT_MATCH ?? "^ix-")
const CONNECT_ALL = (process.env.CONNECT_ALL ?? "false").toLowerCase()
const CUSTOM_NETWORKS = process.env.CUSTOMS_NETWORKS?.split(",") ?? []
// Created at startup for containers to join later, so never cleaned up.
const STARTUP_NETWORKS = CONNECT_ALL !== "false" ? [NETWORK_NAME, ...CUSTOM_NETWORKS] : CUSTOM_NETWORKS
const REV_PROXY_NETWORKS = process.env.REV_PROXY_NETWORKS?.toLowerCase() === "true"
const REV_PROXY_NETWORK_LABEL = process.env.REV_PROXY_NETWORK_LABEL
const REV_PROXY_NETWORK_MATCH = REV_PROXY_NETWORKS ? new RegExp(process.env.REV_PROXY_NETWORK_MATCH ?? "") : undefined
const REV_PROXY_CONTAINER = process.env.REV_PROXY_CONTAINER
if (REV_PROXY_NETWORKS && (!REV_PROXY_NETWORK_LABEL || !REV_PROXY_CONTAINER)) {
  throw new Error("REV_PROXY_NETWORKS=true needs REV_PROXY_NETWORK_LABEL and REV_PROXY_CONTAINER")
}
// Set on networks Dragonify creates for the reverse proxy; the value is the
// project/service that first asked for the network.
const REV_PROXY_NETWORK_OWNER_LABEL = "tj.horner.dragonify.rev-proxy-network"

async function setUpNetwork(docker: Docker) {
  if (CONNECT_ALL !== "false" ) {
    logger.info(`"${NETWORK_NAME}" will be created for connect all your containers`)
  }
  else {
    const existingNetworks = await docker.listNetworks()
    const NETWORK_NAME_exist = existingNetworks.find((thisnetwork: any) => thisnetwork.Name === NETWORK_NAME)
    if (NETWORK_NAME_exist) {
      logger.info(`Network "${NETWORK_NAME}" is present but CONNECT_ALL set to "False". This network will be remove.`)
      await removeNetwork(docker, NETWORK_NAME_exist.Id)
    }
  }

  for (const network_name of STARTUP_NETWORKS) {
    logger.info(`Setting up network "${network_name}"`)
    await ensureNetwork(docker, network_name)
  }
}

async function ensureNetwork(docker: Docker, network_name: string, extraLabels: Record<string, string> = {}) {
  const existingNetworks = await docker.listNetworks({filters: {name: [network_name]}})
  if (existingNetworks.find(n => n.Name === network_name)) {
    logger.debug(`Network "${network_name}" already exists`)
    return
  }
  try {
    await docker.createNetwork({
      Name: network_name,
      Driver: "bridge",
      Internal: true,
      Labels: {
        "tj.horner.dragonify.networks": "true",
        ...extraLabels
      },
    })
    logger.info(`Network "${network_name}" created`)
  } catch (e: any) {
    if (e.statusCode !== 409) throw e
    logger.debug(`Network "${network_name}" already exists (race condition)`)
  }
}

function getDnsName(container: Docker.ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels["com.docker.compose.project"]
  return `${service}.${project}.svc.cluster.local`
}

function prohibitedNetworkMode(networkMode: string) {
  return [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
}

async function connectToNetwork(docker: Docker, container: Docker.ContainerInfo, network_name: string) {
  if (prohibitedNetworkMode(container.HostConfig.NetworkMode)) {
    logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`)
    return
  }

  await ensureNetwork(docker, network_name)

  const network = docker.getNetwork(network_name)
  const dnsName = getDnsName(container)

  logger.debug(`Connecting container ${container.Id} to network "${network_name}" as ${dnsName}`)

  try {
    await network.connect({
      Container: container.Id,
      EndpointConfig: {
        Aliases: [ dnsName ]
      }
    })
  } catch (e: any) {
    logger.error(`Failed to connect container ${container.Id} to network "${network_name}":`, e)
    return
  }

  logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) connected to network "${network_name}" as ${dnsName}`)
}

function isContainerInNetwork(container: Docker.ContainerInfo, network_name: string) {
  return container.NetworkSettings.Networks[network_name] !== undefined
}

function isManagedProject(name: string | undefined) {
  return name !== undefined && PROJECT_MATCH.test(name)
}

function isManagedContainer(container: Docker.ContainerInfo) {
  return isManagedProject(container.Labels["com.docker.compose.project"])
}

function isNetworkSpecified(container: Docker.ContainerInfo) {
  return container.Labels["tj.horner.dragonify.networks"] !== undefined
}

function getRevProxyNetwork(container: Docker.ContainerInfo) {
  const name = container.Labels[REV_PROXY_NETWORK_LABEL!]
  // A container sharing another's network stack (or none/host) can't join it.
  return REV_PROXY_NETWORKS && name && REV_PROXY_NETWORK_MATCH!.test(name) &&
    !prohibitedNetworkMode(container.HostConfig.NetworkMode) ? name : undefined
}

async function connectToAllNetworks(docker: Docker, container: Docker.ContainerInfo) {
  const networkList:string[] = []
  if (CONNECT_ALL !== "false" ) {
    logger.info(`${container.Names} will be connected to all others`)
    networkList.push(NETWORK_NAME)
  }
  if (isNetworkSpecified(container)) {
    networkList.push(...container.Labels["tj.horner.dragonify.networks"].split(','))
  }

  // A private network shared with the reverse proxy, named by the container's
  // REV_PROXY_NETWORK_LABEL (e.g. traefik.docker.network, which also tells Traefik
  // to route over it).
  const revProxyNetwork = getRevProxyNetwork(container)
  if (revProxyNetwork) {
    const owner = `${container.Labels["com.docker.compose.project"]}/${container.Labels["com.docker.compose.service"]}`
    await ensureNetwork(docker, revProxyNetwork, { [REV_PROXY_NETWORK_OWNER_LABEL]: owner })
    const claimedBy = (await docker.getNetwork(revProxyNetwork).inspect()).Labels?.[REV_PROXY_NETWORK_OWNER_LABEL]
    if (claimedBy !== owner) {
      logger.warn(`${container.Names} is joining reverse proxy network "${revProxyNetwork}", which ${claimedBy ? `${claimedBy} also uses` : "Dragonify did not create"}; they can reach each other's ports`)
    }
    networkList.push(revProxyNetwork)
  }

  for (const network_name of networkList) {
    if (isContainerInNetwork(container, network_name)) {
      logger.debug(`Container ${container.Id} already connected to network "${network_name}"`)
      continue
    }
    logger.info(`Connecting ${container.Names} to "${network_name}"`)
    await connectToNetwork(docker, container, network_name)
  }

  if (revProxyNetwork) {
    await connectRevProxy(docker, revProxyNetwork)
  }

  logger.info(`${container.Names} is connected to all its networks`)
}

async function connectRevProxy(docker: Docker, network_name: string) {
  let revProxy
  try {
    revProxy = await docker.getContainer(REV_PROXY_CONTAINER!).inspect()
  } catch (e: any) {
    if (e.statusCode !== 404) throw e
    logger.warn(`Reverse proxy container "${REV_PROXY_CONTAINER}" not found, will connect it to "${network_name}" when it starts`)
    return
  }
  if (revProxy.NetworkSettings.Networks[network_name]) return

  try {
    await docker.getNetwork(network_name).connect({ Container: revProxy.Id })
    logger.info(`Reverse proxy container "${REV_PROXY_CONTAINER}" connected to network "${network_name}"`)
  } catch (e: any) {
    logger.error(`Failed to connect reverse proxy container "${REV_PROXY_CONTAINER}" to network "${network_name}":`, e)
  }
}

async function connectAllContainersToAppsNetwork(docker: Docker) {
  logger.debug("Connecting existing app containers to network")

  const containers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  })

  for (const container of containers.filter(isManagedContainer)) {
    try {
      await connectToAllNetworks(docker, container)
    } catch (e: any) {
      logger.error(`Failed to connect ${container.Names} to its networks:`, e)
    }
  }

  logger.info("All configured app containers connected to their network")
}

async function connectNewContainerToAppsNetwork(docker: Docker, containerId: string) {
  const [ container ] = await docker.listContainers({
    filters: {
      id: [ containerId ]
    }
  })

  if (!container) {
    logger.warn(`Container ${containerId} not found`)
    return
  }

  logger.debug(`New container started: ${container.Id}`)
  await connectToAllNetworks(docker, container)
}

// Disconnects every container still referencing the network, stopped ones
// included (a stopped container can't start again once its network is gone),
// then removes the network.
async function removeNetwork(docker: Docker, networkId: string) {
  const network = docker.getNetwork(networkId)
  const users = await docker.listContainers({ all: true, filters: { network: [ networkId ] } })
  for (const container of users) {
    await network.disconnect({ Container: container.Id, Force: true })
  }
  await network.remove()
}

// Removes Dragonify's networks that no container references any more. Stopped
// containers count, so a stopped app keeps its networks until it is removed.
async function removeUnusedNetworks(docker: Docker) {
  const dragonifyNetworks = await docker.listNetworks({ filters: { label: [ "tj.horner.dragonify.networks" ] } })

  for (const network of dragonifyNetworks.filter(n => !STARTUP_NETWORKS.includes(n.Name))) {
    try {
      const users = await docker.listContainers({ all: true, filters: { network: [ network.Id ] } })
      // A reverse proxy network is unused once only the reverse proxy references it.
      const others = users.filter(c => !(network.Labels?.[REV_PROXY_NETWORK_OWNER_LABEL] && c.Names.includes(`/${REV_PROXY_CONTAINER}`)))
      if (others.length > 0) {
        logger.debug(`Network "${network.Name}" is used by: ${others.flatMap(c => c.Names).join(", ")}`)
        continue
      }
      logger.info(`Network "${network.Name}" is no longer used and will be deleted.`)
      await removeNetwork(docker, network.Id)
    } catch (e: any) {
      logger.error(`Failed to clean up network "${network.Name}":`, e)
    }
  }
}

async function main() {
  const docker = new Docker()

  await setUpNetwork(docker)

  // Startup, start and removal handling run one at a time through this queue,
  // so cleanup after one container is removed can't delete a network that a
  // starting container is about to join (compose does both on a redeploy).
  let queue = Promise.resolve()
  const enqueue = (task: string, work: () => Promise<unknown>) => {
    queue = queue.then(work).then(() => {}, e => { logger.error(`${task} failed:`, e) })
  }

  const events = getEventStream(docker)
  enqueue("Connecting existing containers", () => connectAllContainersToAppsNetwork(docker))
  enqueue("Network cleanup", () => removeUnusedNetworks(docker))

  events.on("container.start", (event) => {
    const containerAttributes = event.Actor.Attributes
    // A recreated reverse proxy container has lost its reverse proxy networks.
    if (REV_PROXY_NETWORKS && containerAttributes["name"] === REV_PROXY_CONTAINER) {
      enqueue("Reconnecting reverse proxy", () => connectAllContainersToAppsNetwork(docker))
      return
    }
    if (!isManagedProject(containerAttributes["com.docker.compose.project"])) {
      return
    }

    enqueue(`Connecting ${containerAttributes["name"]}`, () => connectNewContainerToAppsNetwork(docker, event.Actor["ID"]))
  })

  // Cleanup runs when a container is removed, not when it stops: a stopped
  // container still references its networks and needs them to start again.
  events.on("container.destroy", (event) => {
    const containerAttributes = event.Actor.Attributes
    if (!isManagedProject(containerAttributes["com.docker.compose.project"])) {
      return
    }

    enqueue("Network cleanup", () => removeUnusedNetworks(docker))
  })
}

main()
