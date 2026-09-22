import {
  executePreparedGsWorkers,
  type GsWorkerBatchRequest,
  type GsWorkerBatchResponse
} from './index.js'

let started = false

process.on('message', async (message: GsWorkerBatchRequest) => {
  if (started || message?.kind !== 'gsts-gs-worker-batch') return
  started = true

  let response: GsWorkerBatchResponse
  try {
    const profiles = await executePreparedGsWorkers(message.entries, {
      maxParallel: message.maxParallel,
      compact: message.compact,
      profile: message.profile
    })
    response = {
      kind: 'gsts-gs-worker-batch-result',
      ...(message.profile ? { profiles } : {})
    }
  } catch (error) {
    const details =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...(error.stack ? { stack: error.stack } : {}),
            ...(typeof (error as Error & { code?: unknown }).code === 'string' ||
            typeof (error as Error & { code?: unknown }).code === 'number'
              ? { code: (error as Error & { code: string | number }).code }
              : {})
          }
        : { name: 'Error', message: String(error) }
    response = {
      kind: 'gsts-gs-worker-batch-result',
      error: details
    }
    process.exitCode = 1
  }

  if (!process.send) return
  process.send(response, undefined, undefined, () => process.disconnect())
})
