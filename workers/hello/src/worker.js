export default {
    async fetch(_req, env) {
      const environment = env?.ENV || "preview";
      const secret = env?.MY_SECRET || "no-secret";
      return new Response(`hello from ${environment} with secret: ${secret} 👋`);
    }
  };
  