import {
  defineSourceControlDriver,
  withOwnServices,
  type SourceControlDriverServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";
import * as TangledApi from "./TangledApi.ts";
import { TangledAuth } from "./TangledAuth.ts";
import * as TangledAuthLive from "./TangledAuthLive.ts";
import * as TangledPullRequestProvider from "./TangledPullRequestProvider.ts";
import * as TangledSourceControlProvider from "./TangledSourceControlProvider.ts";

const makeInstance = Effect.all({
  sourceControl: TangledSourceControlProvider.make,
  discovery: TangledSourceControlProvider.makeDiscovery,
  pullRequests: TangledPullRequestProvider.make,
  signIn: Effect.gen(function* () {
    return (yield* TangledAuth).signIn;
  }),
});

/** The driver over a given sign-in, so tests and the OAuth layer can each supply theirs. */
const make = (auth: Layer.Layer<TangledAuth, never, SourceControlDriverServices>) =>
  defineSourceControlDriver({
    kind: definition.kind,
    definition,
    make: withOwnServices(makeInstance, TangledApi.layer.pipe(Layer.provideMerge(auth))),
  });

export const driver = make(TangledAuthLive.layer);
