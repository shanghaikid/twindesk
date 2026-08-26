import { createServer, type Server, type ServerResponse } from 'node:http'

export type CodexFixtureBehavior =
  | { readonly kind: 'complete'; readonly text: string }
  | {
      readonly kind: 'advertisedFunctionCall'
      readonly choices: readonly {
        readonly name: string
        readonly arguments: Readonly<Record<string, unknown>>
      }[]
    }
  | { readonly kind: 'hold' }

export interface CodexFixtureRequest {
  readonly body: Readonly<Record<string, unknown>>
}

export interface CodexResponsesFixture {
  readonly baseUrl: string
  readonly requests: CodexFixtureRequest[]
  waitForRequest(index: number): Promise<void>
  close(): Promise<void>
}

function responseObject(text: string): Record<string, unknown> {
  const message = {
    id: 'msg_twindesk_fixture',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
  }
  return {
    id: 'resp_twindesk_fixture',
    object: 'response',
    created_at: 1,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: 'fixture-model',
    output: [message],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
    user: null,
    metadata: {},
  }
}

function completeEvents(text: string): Record<string, unknown>[] {
  const completed = responseObject(text)
  const message = (completed.output as Record<string, unknown>[])[0]!
  const part = (message.content as Record<string, unknown>[])[0]!
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: completed },
  ]
}

function functionCallEvents(
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  const argumentsText = JSON.stringify(argumentsValue)
  const item = {
    id: 'fc_twindesk_fixture',
    type: 'function_call',
    status: 'completed',
    name,
    arguments: argumentsText,
    call_id: 'call_twindesk_fixture',
  }
  const completed = { ...responseObject(''), output: [item] }
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed },
  ]
}

function advertisedFunctionNames(body: Readonly<Record<string, unknown>>): Set<string> {
  if (!Array.isArray(body.tools)) return new Set()
  return new Set(
    body.tools.flatMap((tool): string[] => {
      if (tool === null || typeof tool !== 'object') return []
      const record = tool as Record<string, unknown>
      return record.type === 'function' && typeof record.name === 'string' ? [record.name] : []
    }),
  )
}

function readRequest(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
    server.closeAllConnections()
  })
}

export async function startCodexResponsesFixture(
  script: readonly CodexFixtureBehavior[],
): Promise<CodexResponsesFixture> {
  const behaviors = [...script]
  const requests: CodexFixtureRequest[] = []
  const waiters = new Map<number, Array<() => void>>()
  const openResponses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    openResponses.add(response)
    response.on('close', () => openResponses.delete(response))
    void readRequest(request).then((body) => {
      const parsedBody = JSON.parse(body) as Record<string, unknown>
      const index = requests.push({ body: parsedBody }) - 1
      for (const resolve of waiters.get(index) ?? []) resolve()
      waiters.delete(index)
      const behavior = behaviors.shift()
      if (behavior === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unexpected Responses request' } }))
        return
      }
      const advertised = advertisedFunctionNames(parsedBody)
      const call =
        behavior.kind === 'advertisedFunctionCall'
          ? behavior.choices.find((choice) => advertised.has(choice.name))
          : undefined
      if (behavior.kind === 'advertisedFunctionCall' && call === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'fixture call was not advertised' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'req_twindesk_fixture',
      })
      if (behavior.kind === 'hold') return
      const events =
        behavior.kind === 'complete'
          ? completeEvents(behavior.text)
          : functionCallEvents(call!.name, call!.arguments)
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Codex Responses fixture did not acquire a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async waitForRequest(index): Promise<void> {
      if (requests[index] !== undefined) return
      await new Promise<void>((resolve) => {
        const entries = waiters.get(index) ?? []
        entries.push(resolve)
        waiters.set(index, entries)
      })
    },
    async close(): Promise<void> {
      for (const response of openResponses) response.destroy()
      await closeServer(server)
    },
  }
}
