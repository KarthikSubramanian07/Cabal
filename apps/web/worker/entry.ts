import { handleAgentRequest, type AssetEnv } from "../src/agent/gateway.js";

export default {
  async fetch(request: Request, env: AssetEnv): Promise<Response> {
    return handleAgentRequest(request, env);
  },
};
