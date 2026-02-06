import { Hono } from 'hono'

export const triggersRoutes = new Hono()

// In-memory queue for triggers (could be file-based for persistence)
const triggerQueue: Array<{
  id: string
  triggerId: string
  agentId?: string
  type: string
  payload: any
  receivedAt: string
}> = []

// Receive trigger webhook from backend
triggersRoutes.post('/webhook', async (c) => {
  try {
    const payload = await c.req.json()

    const trigger = {
      id: crypto.randomUUID(),
      triggerId: payload.trigger_id || payload.triggerId,
      agentId: payload.agent_id || payload.agentId,
      type: payload.trigger_type || payload.type || 'unknown',
      payload,
      receivedAt: new Date().toISOString(),
    }

    console.log('[Kortix Master] Received trigger webhook:', {
      triggerId: trigger.triggerId,
      agentId: trigger.agentId,
      type: trigger.type,
    })

    triggerQueue.push(trigger)

    // Keep only last 100 triggers
    if (triggerQueue.length > 100) {
      triggerQueue.shift()
    }

    return c.json({
      success: true,
      id: trigger.id,
      message: 'Trigger received',
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('[Kortix Master] Trigger webhook error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Get pending triggers for this sandbox
triggersRoutes.get('/pending', async (c) => {
  return c.json({
    triggers: triggerQueue,
    count: triggerQueue.length,
  })
})

// Clear all pending triggers
triggersRoutes.delete('/pending', async (c) => {
  const count = triggerQueue.length
  triggerQueue.length = 0
  return c.json({ success: true, cleared: count })
})

// Acknowledge a specific trigger (remove from queue)
triggersRoutes.post('/:id/ack', async (c) => {
  const id = c.req.param('id')
  const index = triggerQueue.findIndex(t => t.id === id)

  if (index === -1) {
    return c.json({ error: 'Trigger not found' }, 404)
  }

  const [removed] = triggerQueue.splice(index, 1)
  return c.json({ success: true, trigger: removed })
})
