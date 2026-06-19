More memory headroom so the API stops restarting under load

Prevented unexpected API restarts under heavy load. Each API instance now runs with more memory headroom, and autoscaling kicks in sooner, so the brief interruptions some requests saw during memory spikes are resolved
