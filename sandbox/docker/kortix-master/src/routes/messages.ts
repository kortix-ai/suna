import { Hono } from 'hono'

export const messagesRoutes = new Hono()

// In-memory queue for messages
const messageQueue: Array<{
  id: string
  message: string
  metadata?: Record<string, any>
  queuedAt: string
}> = []

// Queue a message for the agent
messagesRoutes.post('/queue', async (c) => {
  try {
    const body = await c.req.json<{
      message: string
      metadata?: Record<string, any>
    }>()

    if (!body.message) {
      return c.json({ error: 'Message is required' }, 400)
    }

    const msg = {
      id: crypto.randomUUID(),
      message: body.message,
      metadata: body.metadata,
      queuedAt: new Date().toISOString(),
    }

    console.log('[Kortix Master] Queued message:', body.message.slice(0, 100))

    messageQueue.push(msg)

    // Keep only last 100 messages
    if (messageQueue.length > 100) {
      messageQueue.shift()
    }

    return c.json({
      success: true,
      messageId: msg.id,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('[Kortix Master] Message queue error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Get queued messages
messagesRoutes.get('/pending', async (c) => {
  return c.json({
    messages: messageQueue,
    count: messageQueue.length,
  })
})

// Clear all pending messages
messagesRoutes.delete('/pending', async (c) => {
  const count = messageQueue.length
  messageQueue.length = 0
  return c.json({ success: true, cleared: count })
})

// Acknowledge a specific message (remove from queue)
messagesRoutes.post('/:id/ack', async (c) => {
  const id = c.req.param('id')
  const index = messageQueue.findIndex(m => m.id === id)

  if (index === -1) {
    return c.json({ error: 'Message not found' }, 404)
  }

  const [removed] = messageQueue.splice(index, 1)
  return c.json({ success: true, message: removed })
})
