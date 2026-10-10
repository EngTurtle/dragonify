import Docker from "dockerode"
import EventEmitter from "events"

import { chain } from "stream-chain"
import { parser } from "stream-json/jsonl/Parser"
import { logger } from "./logger"

// Without the event stream Dragonify would keep running but do nothing, so
// exit and let the container's restart policy start a fresh one.
function exitOnLostStream(reason: unknown): never {
  logger.error("Lost the Docker event stream, exiting:", reason)
  process.exit(1)
}

export function getEventStream(docker: Docker): EventEmitter {
  const emitter = new EventEmitter()

  docker.getEvents((err, rawStream) => {
    if (err || !rawStream) exitOnLostStream(err)

    const stream = chain<any[]>([
      rawStream,
      parser()
    ])
    stream.on("error", exitOnLostStream)
    stream.on("end", () => exitOnLostStream("stream ended"))

    stream.on("data", (data) => {
      const event = data.value
      emitter.emit(`${event.Type}.${event.Action}`, data.value)
    })
  })

  return emitter
}
