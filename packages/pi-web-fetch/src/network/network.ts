// Compatibility facade for the public network helpers that predate the internal split.
export {
  isPrivateAddress,
  validateRemoteUrl,
  type ResolveAddresses,
  type ValidatedTarget,
} from "./network-policy.ts";

export {
  decodeResponse,
  decompressResponse,
  FETCH_MAX_BYTES,
  readResponseBytes,
  requestPinned,
  responseHeader,
} from "./network-transport.ts";
