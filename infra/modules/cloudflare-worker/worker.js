export default {
  async fetch(request, env) {
    const activeBackend = env.ACTIVE_BACKEND || 'lightsail';
    
    const backends = {
      lightsail: 'https://api-lightsail.kortix.com',
      ecs: 'https://api-ecs.kortix.com'
    };
    
    const url = new URL(request.url);
    const backendUrl = backends[activeBackend];
    
    if (!backendUrl) {
      return new Response('Invalid backend configuration', { status: 500 });
    }
    
    const targetUrl = new URL(url.pathname + url.search, backendUrl);
    
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });
    
    const response = await fetch(modifiedRequest);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Backend', activeBackend);
    
    return newResponse;
  }
};
