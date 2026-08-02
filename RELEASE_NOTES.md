Prevent passive session reads from restarting sandboxes

Stops project navigation, transcript hydration, polling, and background reconnects from resuming stopped session sandboxes. Explicit session starts, runtime mutations, and intentional preview navigation still resume. Also corrects session activity timestamps so inactive sessions no longer appear newly started.
