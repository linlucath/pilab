import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node's fetch does not consistently inherit HTTP_PROXY without an explicit dispatcher.
// Honor the user's existing proxy while keeping local model endpoints on loopback.
if (
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy
) {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      noProxy: [
        process.env.NO_PROXY || process.env.no_proxy,
        "localhost",
        "127.0.0.1",
        "::1",
      ]
        .filter(Boolean)
        .join(","),
    }),
  );
}
