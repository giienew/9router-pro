// Live model listing for OpenAI/Anthropic-compatible connections, shared by
// the models route and the test-models route. This is the underlying
// operation the test-models route used to reach via an unauthenticated
// HTTP self-fetch (which the dashboard proxy 401s under requireLogin and
// surfaced as a bogus 400 "No models configured"). Calling it directly
// removes the loopback entirely — no credentials are threaded through HTTP,
// the connection's own key talks straight to its upstream /models endpoint.
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Returns { ok: true, models } or { ok: false, status, error } with the
// exact messages the models route historically returned, so callers keep
// identical user-facing behavior.
export async function fetchCompatibleProviderModels(connection) {
  const provider = connection.provider;
  if (isOpenAICompatibleProvider(provider)) {
    const baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) {
      return { ok: false, status: 400, error: "No base URL configured for OpenAI compatible provider", errorText: "" };
    }
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${connection.apiKey}`,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: `Failed to fetch models: ${response.status}`, errorText };
    }
    const data = await response.json();
    return { ok: true, models: data.data || data.models || [] };
  }

  if (isAnthropicCompatibleProvider(provider)) {
    let baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) {
      return { ok: false, status: 400, error: "No base URL configured for Anthropic compatible provider", errorText: "" };
    }
    baseUrl = baseUrl.replace(/\/$/, "");
    if (baseUrl.endsWith("/messages")) {
      baseUrl = baseUrl.slice(0, -9);
    }
    const url = `${baseUrl}/models`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": connection.apiKey,
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${connection.apiKey}`,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: `Failed to fetch models: ${response.status}`, errorText };
    }
    const data = await response.json();
    return { ok: true, models: data.data || data.models || [] };
  }

  return { ok: false, status: 400, error: `Provider ${provider} is not OpenAI/Anthropic compatible`, errorText: "" };
}
