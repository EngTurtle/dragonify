import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const NETWORK_NAME = "apps-internal"
const CONNECT_ALL_ENABLE: string | undefined = process.env.CONNECT_ALL
const CUSTOM_NETWORK_NAMES: string | undefined = process.env.CUSTOMS_NETWORKS
const REV_PROXY_NETWORKS = process.env.REV_PROXY_NETWORKS?.toLowerCase() === "true"
const REV_PROXY_NETWORK_LABEL = process.env.REV_PROXY_NETWORK_LABEL
const REV_PROXY_NETWORK_MATCH = new RegExp(process.env.REV_PROXY_NETWORK_MATCH ?? "")
const REV_PROXY_CONTAINER = process.env.REV_PROXY_CONTAINER
if (REV_PROXY_NETWORKS && (!REV_PROXY_NETWORK_LABEL || !REV_PROXY_CONTAINER)) {
  throw new Error("REV_PROXY_NETWORKS=true needs REV_PROXY_NETWORK_LABEL and REV_PROXY_CONTAINER")
}
// Set on networks Dragonify creates for the reverse proxy; the value is the
// project/service that first asked for the network.
const REV_PROXY_NETWORK_OWNER_LABEL = "tj.horner.dragonify.rev-proxy-network"


if (CONNECT_ALL_ENABLE !== undefined) {
  var CONNECT_ALL: string | undefined = CONNECT_ALL_ENABLE.toLowerCase( )
}
else {
  var CONNECT_ALL: string | undefined = "false"
}
var networks_liste: string[] = [NETWORK_NAME]
if (CUSTOM_NETWORK_NAMES !== undefined) {
  var networks_liste: string[] = CUSTOM_NETWORK_NAMES.split(',')
}
else {
  var networks_liste: string[] = []
}

async function setUpNetwork(docker: Docker) {
  const networkList:string[] = []
  if (CONNECT_ALL !== "false" ) {
    logger.info(`"${NETWORK_NAME}" will be created for connect all your containers`)
    networkList.push(NETWORK_NAME)
  }
  else {
    const existingNetworks = await docker.listNetworks()
    const NETWORK_NAME_exist = existingNetworks.find((thisnetwork: any) => thisnetwork.Name === NETWORK_NAME)
    if (NETWORK_NAME_exist) {
      logger.info(`Network "${NETWORK_NAME}" is present but CONNECT_ALL set to "False". This network will be remove.`)
      const network = await docker.getNetwork(NETWORK_NAME_exist.Id).inspect()
      const containers = network.Containers ?? {}

      for (const containerID of Object.keys(containers)) {
        await docker.getNetwork(network.Id).disconnect({ Container: containerID })
        logger.debug(`Container "${containerID}" is now disconnected from "${network.Name}".`)
      }

      logger.debug(`Network "${network.Name}" is now empty and will be deleted.`)
      await docker.getNetwork(network.Id).remove()

    }
  }

  for (let i = 0; i < networks_liste.length; i++) {
    networkList.push(networks_liste[i])
  }

  for (let i = 0; i < networkList.length; i++) {
    logger.info(`Setting up network "${networkList[i]}"`)

    await ensureNetwork(docker, networkList[i])
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

async function connectContainerToAppsNetwork(docker: Docker, container: Docker.ContainerInfo, network_name: string) {
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

function isIxProjectName(name: string) {
  return name?.startsWith("ix-") ?? false
}

function isIxAppContainer(container: Docker.ContainerInfo) {
  return isIxProjectName(container.Labels["com.docker.compose.project"])
}

function isNetworkSpecified(container: Docker.ContainerInfo) {
  return container.Labels["tj.horner.dragonify.networks"] !== undefined
}

function getRevProxyNetwork(container: Docker.ContainerInfo) {
  const name = container.Labels[REV_PROXY_NETWORK_LABEL!]
  return REV_PROXY_NETWORKS && name && REV_PROXY_NETWORK_MATCH.test(name) ? name : undefined
}

async function connectContainer(docker: Docker, container: Docker.ContainerInfo) {
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
    await connectContainerToAppsNetwork(docker, container, network_name)
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

  for (const container of containers.filter(isIxAppContainer)) {
    try {
      await connectContainer(docker, container)
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
  await connectContainer(docker, container)
}

async function removeEmptyCreatedNetwork(docker: Docker) {
  const existingNetworks = await docker.listNetworks()
  const dragonifyNetworks = existingNetworks.filter((thisnetwork: any) => thisnetwork.Labels["tj.horner.dragonify.networks"])

  for (const networkSummary of dragonifyNetworks) {
    const network = await docker.getNetwork(networkSummary.Id).inspect()
    const containers = network.Containers ?? {}
    // A reverse proxy network counts as empty once only the reverse proxy is left on it.
    const revProxyIds = network.Labels[REV_PROXY_NETWORK_OWNER_LABEL]
      ? Object.keys(containers).filter(id => containers[id].Name === REV_PROXY_CONTAINER)
      : []
    const isEmpty = Object.keys(containers).length === revProxyIds.length
    
    if (isEmpty) {
      logger.info(`Network "${network.Name}" is now empty and will be deleted.`)
      for (const id of revProxyIds) {
        await docker.getNetwork(network.Id).disconnect({ Container: id })
      }
      await docker.getNetwork(network.Id).remove()
    }
    else {
      logger.debug(`Network "${network.Name}" contains containers : ${Object.keys(containers).join(", ")}`)
    }
  }
}

async function main() {
  const docker = new Docker()

  await setUpNetwork(docker)

  // Startup, start and stop handling run one at a time through this queue, so
  // cleanup after one container stops can't delete a network that a starting
  // container is about to join (compose does both at once on a redeploy).
  let queue = Promise.resolve()
  const enqueue = (task: string, work: () => Promise<unknown>) => {
    queue = queue.then(work).then(() => {}, e => { logger.error(`${task} failed:`, e) })
  }

  const events = getEventStream(docker)
  enqueue("Connecting existing containers", () => connectAllContainersToAppsNetwork(docker))

  events.on("container.start", (event) => {
    const containerAttributes = event.Actor.Attributes
    // A recreated reverse proxy container has lost its reverse proxy networks.
    if (REV_PROXY_NETWORKS && containerAttributes["name"] === REV_PROXY_CONTAINER) {
      enqueue("Reconnecting reverse proxy", () => connectAllContainersToAppsNetwork(docker))
      return
    }
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    enqueue(`Connecting ${containerAttributes["name"]}`, () => connectNewContainerToAppsNetwork(docker, event.Actor["ID"]))
  })

  events.on("container.stop", (event) => {
    const containerAttributes = event.Actor.Attributes
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    enqueue("Network cleanup", () => removeEmptyCreatedNetwork(docker))
  })
}

main()
