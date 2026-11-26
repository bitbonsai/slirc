title: Footprint: Slirc next to Campfire
crumb: About / Footprint
description: Measured resource comparison: Campfire (Rails + Redis) against Slirc (Bun + Ergo IRC), RAM, CPU, processes, and image size.
lead: Same job, group chat on our own hardware. Very different footprint.

Campfire is an excellent alternative: open source, self-hosted, runs one command, and [you get the code](https://once.com/campfire). We measured both products side by side to see what the same job costs on our own hardware.

## The numbers

| metric | Campfire | Slirc |
| --- | --- | --- |
| RAM, idle | 1.62 GB (76% of its own 2 GB cap) | ~20 MB total (13.6 MB app + 6.6 MB Ergo) |
| CPU, idle | 2.03% | ~0.1% |
| processes | 220 | 12 |
| image size | ~917 MB (877 MB app + 40 MB Redis) | ~135 MB (97.8 MB app + 36.7 MB Ergo) |
| extra services | separate Redis container | none |

## How it adds up

- RAM: **81×**
- CPU: **~20×**
- processes: **18×**
- disk images: **6.8×**

## Capacity

Campfire sits near its own 2 GiB cap before anyone connects. Slirc's whole stack uses about 1% of that, so the same cap holds roughly 80 Slirc stacks.

Campfire alone eats 1.6 GB of its machine's 31 GB. Slirc's whole stack fits comfortably on its 3.8 GB host.

## Load

Synthesized 250 concurrent IRC clients against the local Ergo instance: all registered and joined, then chattered at ~210 messages/s for 40 seconds, about 52k outbound deliveries after fanout.

| metric | 250 users (measured) | 500 users (modeled) |
| --- | --- | --- |
| Ergo RAM, idle | 17 MiB | 17 MiB |
| Ergo RAM, during load | 39 MiB | 60-80 MiB |
| Ergo CPU, sustained | 5-15% of one core | ~10-30% |
| Ergo CPU, burst spike | ~49% of one core | under one core |
| messages handled | 8.4k in / 52k out | ~2× |

This is the chatty worst case, every user talking continuously. Real groups sit mostly idle at the WebSocket relay, so actual capacity is well above the model.

## Recommended server

Same ladder Campfire publishes (they start at 250 users / 2 GB / 1 CPU). Slirc's numbers start from the measured load above and scale for the whole stack, app relay, Ergo, Caddy, and headroom, not bare Ergo. [Hetzner Cloud](https://www.hetzner.com/cloud/) ARM servers hit these tiers out of the box, prices included.

| concurrent users | RAM | CPU | Hetzner | est. price |
| --- | --- | --- | --- | --- |
| 250 | 1 GB | 1 CPU | cax11 | ~€7/mo |
| 1,000 | 2 GB | 2 CPU | cax11 | ~€7/mo |
| 5,000 | 4 GB | 4 CPU | cax21 | ~€13/mo |
| 10,000 | 8 GB | 8 CPU | cax31 | ~€25/mo |

Memory stays the cheap axis (Ergo idles at ~17 MiB and peaks under 40 MiB for 250 chatty users); the growth curve is CPU and the WebSocket fanout, which is why it climbs slower than Campfire's ladder.

Personal agents add no server load. They run on your machine and connect as one more IRC client.

## What Slirc does not have

Campfire and Slack both have server-side search. Slirc does not yet. Slack has voice and video; Slirc pastes a link. Matrix federates and encrypts end to end; Slirc does neither. This page is about what the same group chat costs to run, and the numbers only make sense next to that list.

## Method

Both hosts measured 2026-09-07 with `podman stats` (three samples, two seconds apart), `podman images`, and `podman system df`. Load numbers measured 2026-09-15 with a 250-client synthetic script against the local stack.