import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const NETWORK_NAME = "apps-internal"
const CONNECT_ALL_ENABLE: string | undefined = process.env.CONNECT_ALL
const CUSTOM_NETWORK_NAMES: string | undefined = process.env.CUSTOMS_NETWORKS
const TRAEFIK_CONTAINER = process.env.TRAEFIK_CONTAINER ?? "traefik"
const ISOLATED_LABEL = "tj.horner.dragonify.traefik-isolated"


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

function isTraefikIsolated(container: Docker.ContainerInfo) {
  return container.Labels[ISOLATED_LABEL] === "true" && container.Labels["traefik.enable"] === "true"
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

  // Named after the compose project, which Docker keeps unique, so two apps
  // can't end up sharing one. traefik.docker.network must match it so Traefik
  // routes over this network.
  const isolatedNetwork = `traefik-${container.Labels["com.docker.compose.project"]}`
  const isolated = isTraefikIsolated(container) && container.Labels["traefik.docker.network"] === isolatedNetwork
  if (isTraefikIsolated(container) && !isolated) {
    logger.warn(`${container.Names} has ${ISOLATED_LABEL}=true but needs traefik.docker.network=${isolatedNetwork}, skipping isolated network`)
  }
  if (isolated) {
    await ensureNetwork(docker, isolatedNetwork, { [ISOLATED_LABEL]: "true" })
    networkList.push(isolatedNetwork)
  }

  for (const network_name of networkList) {
    if (isContainerInNetwork(container, network_name)) {
      logger.debug(`Container ${container.Id} already connected to network "${network_name}"`)
      continue
    }
    logger.info(`Connecting ${container.Names} to "${network_name}"`)
    await connectContainerToAppsNetwork(docker, container, network_name)
  }

  if (isolated) {
    await connectTraefik(docker, isolatedNetwork)
  }

  logger.info(`${container.Names} is connected to all its networks`)
}

async function connectTraefik(docker: Docker, network_name: string) {
  let traefik
  try {
    traefik = await docker.getContainer(TRAEFIK_CONTAINER).inspect()
  } catch (e: any) {
    if (e.statusCode !== 404) throw e
    logger.warn(`Traefik container "${TRAEFIK_CONTAINER}" not found, will connect it to "${network_name}" when it starts`)
    return
  }
  if (traefik.NetworkSettings.Networks[network_name]) return

  try {
    await docker.getNetwork(network_name).connect({ Container: traefik.Id })
    logger.info(`Traefik container "${TRAEFIK_CONTAINER}" connected to network "${network_name}"`)
  } catch (e: any) {
    logger.error(`Failed to connect Traefik container "${TRAEFIK_CONTAINER}" to network "${network_name}":`, e)
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
    await connectContainer(docker, container)
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
    // An isolated network counts as empty once only Traefik is left on it.
    const traefikIds = network.Labels[ISOLATED_LABEL] === "true"
      ? Object.keys(containers).filter(id => containers[id].Name === TRAEFIK_CONTAINER)
      : []
    const isEmpty = Object.keys(containers).length === traefikIds.length
    
    if (isEmpty) {
      logger.info(`Network "${network.Name}" is now empty and will be deleted.`)
      for (const id of traefikIds) {
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
  await connectAllContainersToAppsNetwork(docker)

  const events = getEventStream(docker)
  events.on("container.start", (event) => {
    const containerAttributes = event.Actor.Attributes
    // A recreated Traefik container has lost its isolated networks.
    if (containerAttributes["name"] === TRAEFIK_CONTAINER) {
      connectAllContainersToAppsNetwork(docker)
      return
    }
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    connectNewContainerToAppsNetwork(docker, event.Actor["ID"])
  })

  events.on("container.stop", (event) => {
    const containerAttributes = event.Actor.Attributes
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    removeEmptyCreatedNetwork(docker)
  })
}

main()
