# QuotaRouter

QuotaRouter is a local API router for Claude Code.

If you have multiple Anthropic-compatible APIs — different plans, different providers, even self-hosted services — the usual headache isn't whether they work, but:

* This one's quota is gone, time to manually switch to another
* Some endpoint is temporarily rate-limited, time to edit config again
* Your main line came back, but you don't know when to switch back to it
* For safety, you end up constantly babysitting several services' status

What QuotaRouter does is simple: **hand all your CodingPlan APIs to it, then keep using Claude Code as usual.**

It uses your preferred line first; when quota, rate limits, or service errors hit, it automatically switches to the next available one; when your higher-priority line genuinely recovers, it switches back automatically.

"Recovery" here doesn't mean guessing it's probably fine once the countdown ends — it actually confirms the service is working again, so it won't keep switching back to something that's still broken.

## Think of it as

**An automatic transmission in front of Claude Code.**

Normally you don't touch it.

If the main line works, it stays on the main line;
If the main line has issues, it switches to backup automatically;
When the main line recovers, it comes back automatically.

If you want to pin a specific service temporarily, you can switch it directly in the Dashboard — no restart needed.

## When it fits

If you:

* Have two or three or more Claude / Anthropic-compatible APIs
* Don't want to manually edit environment variables after quota runs out
* Have a main line and backup lines
* Different APIs differ in stability, quota, or available hours
* Want Claude Code to stay available as much as possible

Then QuotaRouter is basically built for this scenario.

## How to use

Install and fill in your API backends, then point Claude Code at QuotaRouter.

After that, keep using Claude Code as usual — line selection and failover are handled by QuotaRouter.

There's also a local Dashboard where you can see which service is currently in use, which lines are temporarily unavailable, and adjust order or pin a line manually at any time.

## The core problem it solves

QuotaRouter isn't about making APIs faster, nor about wrapping many models into a new platform.

It just solves one very practical problem:

> **I already have several working APIs — can you stop making me manage them manually every day?**

Yes.

Line them up by priority, and let QuotaRouter handle the rest.

## License

MIT
