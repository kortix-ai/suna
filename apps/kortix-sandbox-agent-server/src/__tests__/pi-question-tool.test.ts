import { expect, test } from 'bun:test'
import { QuestionBroker } from '@/harness/pi/interactions'
import { createQuestionTool } from '@/harness/pi/tools'

test('the question tool returns the answers as structured details, as OpenCode does', async () => {
  const broker = new QuestionBroker('ses_root', () => {})
  const tool = createQuestionTool(broker, () => ({ messageID: 'msg_1', callID: 'call_1' }))
  const run = tool.execute('call_1', {
    questions: [{ question: 'Stack?', header: 'Stack', options: [{ label: 'Vue', description: 'Vue 3' }] }],
  } as never)
  const [asked] = broker.list()
  broker.reply(asked!.id, [['Vue']])
  const result = await run
  expect(result.details).toEqual({ answers: [['Vue']] })
  expect(result.content).toEqual([{ type: 'text', text: 'User answered:\nStack: Vue' }])
})
