import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

// Identity + Durable Object exports, split out so the DO bindings below can reference this
// Worker by definition (a name string would leave `env.DIVE_AGENT` etc. untyped).
const self = defineWorker({
	name: "krillion-bench",
	compatibilityDate: "2026-11-10",
	entrypoint,
	exports: {
		DiveAgent: exports.durableObject({ storage: "sqlite" }),
		DayCoordinator: exports.durableObject({ storage: "sqlite" }),
		OpenAICredentials: exports.durableObject({ storage: "sqlite" }),
	},
});

export default defineConfig({
	accountId: "b8a6047310bbd4b0a0e5374e91089308",
	worker: {
		...self,
		compatibilityFlags: [
			"nodejs_compat",
		],
		// Setting routes turns workers.dev off by default; the admin portal (Access app) lives there.
		workersDev: true,
		limits: {
			cpuMs: 300000,
		},
		observability: {
			enabled: true,
			traces: {
				enabled: true,
			},
			issues: {
				enabled: false,
			},
		},
		// Leaderboard frontend (public/, see wrangler.config.ts) served from the same Worker;
		// /api/* and /admin* hit the Worker first.
		assets: {
			runWorkerFirst: [
				"/api/*",
				"/admin",
				"/admin/*",
			],
		},
		triggers: [
			// krillion.agentfan.club lives in the agent fan club account. It reaches this Worker as a
			// Cloudflare for SaaS custom hostname on realartists.work (fallback origin
			// saas.realartists.work); the agentfan.club zone only has a DNS-only CNAME
			// krillion → saas.realartists.work (+ the _cf-custom-hostname TXT ownership record).
			triggers.fetch({
				pattern: "krillion.agentfan.club/*",
				zone: "realartists.work",
			}),
			// Krillion resets at 00:00 America/New_York. Workers cron is UTC-only, so fire at
			// both possible UTC hours (EDT = 04:05, EST = 05:05); the handler keeps the one
			// where it is 00:xx in New York.
			triggers.scheduled({
				schedule: "5 4 * * *",
			}),
			triggers.scheduled({
				schedule: "5 5 * * *",
			}),
		],
		env: {
			// Cloudflare Access app "krillion-bench admin" protects <host>/admin; the Worker re-checks its token.
			ACCESS_TEAM_DOMAIN: bindings.text("https://adhi-thirumala.cloudflareaccess.com"),
			ACCESS_AUD: bindings.text("3e841e752d8d433901699961c4d6d841d4b0d8c851608b6f6b6f18041e943874"),
			ADMIN_EMAILS: bindings.text("adhi.thirumala@gmail.com,hello@agentfanclub.org"),
			// This project's AI Gateway: Workers AI billed postpaid; Anthropic/OpenAI use BYOK keys
			// stored on the gateway (default alias).
			AI_GATEWAY: bindings.text("krillion-bench"),
			// D1 migrations live in ./migrations, the `cf d1 migrations apply` default.
			DB: bindings.d1({
				name: "krillion-bench",
				id: "df640cba-0fe8-483f-b179-132aa895ea7e",
			}),
			CONFIG: bindings.kv({
				id: "e0138a87a3ad420c84656f535c72b9f4",
			}),
			DIVE_AGENT: bindings.durableObject<typeof self, "DiveAgent">({ worker: self, exportName: "DiveAgent" }),
			DAY_COORDINATOR: bindings.durableObject<typeof self, "DayCoordinator">({ worker: self, exportName: "DayCoordinator" }),
			OPENAI_CREDENTIALS: bindings.durableObject<typeof self, "OpenAICredentials">({ worker: self, exportName: "OpenAICredentials" }),
			AI: bindings.ai({}),
			BROWSER: bindings.browser({}),
			ASSETS: bindings.assets(),
		},
	},
});
