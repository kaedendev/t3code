// @effect-diagnostics nodeBuiltinImport:off - a one-off key generator, run by hand before deploys.
import * as NodeCrypto from "node:crypto";

const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
process.stdout.write(
  `${JSON.stringify({ ...jwk, kid: NodeCrypto.randomUUID(), alg: "ES256", use: "sig" })}\n`,
);
