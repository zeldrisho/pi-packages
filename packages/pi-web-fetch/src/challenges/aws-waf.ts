import type { IncomingMessage } from "node:http";
import type { RedirectDependencies } from "../network/network-redirects.ts";

/** Cookie that carries an AWS WAF challenge token. */
export const AWS_WAF_TOKEN_COOKIE = "aws-waf-token";

/** A resolved AWS WAF token and the browser identity it was issued for. */
export interface AwsWafSolution {
  token: string;
  userAgent?: string;
}

/** A request to resolve one AWS WAF challenge. */
export interface AwsWafResolveContext {
  /** The page URL withheld by the challenge. */
  url: URL;
  /** Cancels the solver request. */
  signal: AbortSignal;
  /** Network dependencies used by the resolver. */
  network?: RedirectDependencies;
}

/** Resolves an AWS WAF challenge to a token accepted by the target origin. */
export interface AwsWafResolver {
  resolve(context: AwsWafResolveContext): Promise<AwsWafSolution | undefined>;
}

/** Returns whether a response carries an AWS WAF challenge. */
export function isAwsWafChallengeResponse(response: Pick<IncomingMessage, "headers">): boolean {
  const value = response.headers["x-amzn-waf-action"];
  const action = Array.isArray(value) ? value[0] : value;

  return action?.trim().toLowerCase() === "challenge";
}
