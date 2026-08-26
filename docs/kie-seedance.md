# seedance 2.0 mini on kie.ai — what the API actually does

Everything here was measured against the live API on 2026-07-30, not read off the
marketing page. Two real generations were run at 480p; the numbers below are what
came back.

## Calling it

```
POST https://api.kie.ai/api/v1/jobs/createTask     {"model": …, "input": {…}}   → data.taskId
GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=…                         → data.state, …
```

`Authorization: Bearer <key>`, JSON in and out. A rejected request answers
`code: 500, msg: "Value must be within the specified range"` and **costs nothing**,
which is what makes it safe to probe the limits.

Model id: **`bytedance/seedance-2-mini`**

## Input

| field | what it takes | limits |
|---|---|---|
| `prompt` | the instruction | — |
| `reference_video_urls` | list of video URLs | ≤ 3 files, **total ≤ 15 s**, ≤ 50 MB, mp4 / mov / mkv |
| `reference_image_urls` | list of image URLs | ≤ 9 files, ≤ 30 MB, jpg / png / webp / gif |
| `reference_audio_urls` | list of audio URLs | ≤ 3 files, total ≤ 15 s, ≤ 15 MB, mpeg / wav |
| `first_frame_url`, `last_frame_url` | frames to start and end on | images |
| `duration` | output length in seconds | **integer 4 … 15** |
| `resolution` | `480p` \| `720p` | |
| `aspect_ratio` | `16:9` `4:3` `1:1` `3:4` `9:16` `21:9` `adaptive` | |
| `generate_audio` | make a soundtrack too | |
| `web_search`, `nsfw_checker` | flags | |

Every file is fetched **by URL from the outside**, so nothing on `localhost:8765`
can be used. catbox.moe takes both our mp4 and our jpg and serves them back with
the right content type; imgbb is images only.

`first_frame_url` is what makes a long fragment possible: cut it into pieces of
at most 15 s, and hand the last frame of one result in as the first frame of the
next.

## Output

`state` goes `waiting` → `success` (or `fail`, with `failCode` / `failMsg`).
The video URL is inside `resultJson`:

```json
{"resultUrls": ["https://tempfile.aiquickdraw.com/seedance/…mp4"]}
```

That host is temporary — the file has to be downloaded and stored locally as soon
as the task reports success.

Measured on a 3 s, 480×854 input with `aspect_ratio: adaptive`:

* out: **496×864, 24 fps**, h264 — close to the source ratio but not equal to it,
  so the result still has to be fitted to the project canvas;
* **no audio stream at all** with `generate_audio: false` — the original sound is
  kept simply by leaving the clip's own audio alone;
* both runs took **~270 s** regardless of length (4 s and 15 s alike), so the wait
  is roughly four and a half minutes whatever is asked for.

## What it costs

Price list: 480p — 6 credits/s with a video input, 9.5 without; 720p — 12.5 / 20.5.
"With video" is charged as `price × (input + output)`.

Measured, 480p, 3 s input:

| output | credits | dollars |
|---|---|---|
| 15 s | 120 | ≈ $0.60 |
| 4 s | 54 | ≈ $0.27 |

Both fit `6 × (5 + output)` — the 3 s input was billed as **5 s**, so the input
side has a floor (or rounds up in five-second steps; one input length cannot tell
the two apart). For an estimate in the tool: `credits = 6 × (max(5, input) + output)`
at 480p, roughly double at 720p, and 1 credit ≈ $0.005.

## Two things that decide the design

**Ask for the length you have.** With `duration: 15` on a 3 s reference, the model
keeps the person and the scene and simply **invents the remaining twelve seconds** —
still talking, still plausible. With `duration: 4` it stays on the source. So the
request has to be `clamp(ceil(fragment), 4, 15)` and the result trimmed back to the
fragment's exact length.

**Whatever is burnt into the picture is regenerated with it.** The 4 s result
carries the source's own burnt-in caption through; the 15 s one dropped it once it
started inventing. Nothing to fix on our side — it is a reason to feed the raw
asset rather than anything the app has drawn over it.

## Face swap, as tested

Prompt used:

> Replace the face of the person in the video with the face from the reference
> image. Keep the original expression, head motion, lighting, hair and background.

with the fragment in `reference_video_urls` and one face in `reference_image_urls`.
The reference identity — including the rimless glasses — came through, while the
clothing, framing, background and mouth movement stayed with the source.

## Face swap: four runs, one landing

Measured, all 480p, 4 s asked for on a 3.4 s fragment of the same clip:

| # | reference face | input size | prompt | result |
|---|---|---|---|---|
| 1 | woman, 768² | 720×1280 | `@Image1`, keep expression/lighting/hair | scene regenerated, **original face** |
| 2 | woman, 768² | 720×1280 | no tokens, the wording from the contract test | scene regenerated, **original face** |
| 3 | woman, 768² | 480×854 | `@Image1` no space, short keep clause | **face replaced** — and the whole person with it: hair, earrings and top came from the reference |
| 4 | man, 768² | 480×854 | as 3, plus "change only the face" and the no-lettering rule | **nothing changed at all** — original face, source caption still sharp |

So neither the token spelling nor the input size decides it: run 2 had the plain
wording that worked during the contract test and still did not swap, and run 4
had everything run 3 had plus two more sentences and swapped nothing.

What the runs do show:

* **Preservation language competes with the swap.** The one that worked said the
  least about keeping things; the one that changed nothing said the most.
* **The model treats a face reference as a person, not a face.** Run 3 brought the
  reference's hair, jewellery and clothing along.
* **Naming watermarks or logos gets the job refused outright**, with
  `failCode 500, "the output video may be related to copyright restrictions"` and
  no credits charged. Asking for "no lettering in the frame" instead is accepted.
* Burnt-in text from the source survives or turns to nonsense; it is part of the
  picture being regenerated.

A video model asked to carry an identity across is evidently a coin toss at this
length. The reliable shape for this job is the one the Replace character tool was
sketched with: edit the **first frame** with an image model, hand that back as
`first_frame_url` alongside the video, and let seedance animate from a picture
that already has the right face in it.

## A frame and a video cannot both be given

Measured, and it settles the whole design:

```
first/last frame content cannot be mixed with reference media content
```

`first_frame_url` / `last_frame_url` and `reference_video_urls` are **mutually
exclusive** — the request is rejected outright, `failCode 500`, no credits taken.

That rules out three things at once:

* anchoring the output on an edited frame while still handing over the fragment
  for its motion;
* keeping the head of a fragment as original footage and generating the tail from
  an edited frame plus the same fragment;
* chaining pieces of a long fragment by feeding the last frame of one part in as
  the first frame of the next **while also** passing that part's video.

What is left, and what works: put the edited frame in `reference_image_urls`
alongside the video. The frame then carries the identity without dictating where
the output starts, so the timing stays with the source and the original audio
still fits.

## Editing the anchor frame first — nano-banana-2-lite

Model id **`nano-banana-2-lite`**, same jobs API. Input: `prompt`,
`image_urls` (up to 10), `aspect_ratio` (`auto` keeps the source shape).
**4 credits ≈ $0.02**, and it came back in **5 seconds**.

Handed the full-resolution source frame and a library face, told to change the
face and nothing else and to show no lettering, it returned the same shot with
the reference man's face, the source's hair, shirt, room and framing — and the
burnt-in caption gone. One frame at 576×1024 from a 720×1280 input, so `auto`
keeps the ratio but not the size.

That makes the working shape for a face swap:

1. find the frame where the face first appears (locally, free);
2. edit that one frame — 2 cents, 5 seconds, and it can be judged and retried;
3. send the fragment plus the approved frame as a reference image, never as a
   first frame.

## Kling 3.0 Motion Control — the contract, as measured

Model id **`kling-3.0/motion-control`**. Purpose-built for this errand: the
character comes from one picture, the movement from one video.

| field | what it takes | notes |
|---|---|---|
| `input_urls` | exactly one image | jpg/png, ≤ 10 MB, ≥ 340 px, ratio 2:5 … 5:2 |
| `video_urls` | exactly one video | mp4/mov, ≤ 100 MB, **3 … 30 s** |
| `prompt` | optional, ≤ 2500 chars | guides the animation, does not choose the person |
| `mode` | **`720p` / `1080p`** | see below |
| `character_orientation` | `video` (default) / `image` | `image` caps the clip at 10 s |
| `background_source` | `input_video` (default) / `input_image` | which scene the result keeps |

No `duration`: the result is as long as the reference video. Charged per second
of that video — **12 credits/s at 720p, 21 at 1080p** — and a task holds 120
credits while it runs, refunded in full if it fails.

**`mode` is the resolution, not a tier.** kie's own doc says in prose "std:
Standard Mode (720p), pro: Professional Mode (1080p)", and both `std` and `pro`
are answered with `code 500, "mode is not within the range of allowed options"`.
The doc's own JSON example is right and its prose is wrong: `720p` and `1080p`
are accepted. Omitting `mode` altogether is also accepted.

### What it refuses, and it is not the settings

```
failCode 400, "No valid characters detected in the video"    — 0 credits charged
```

Every talking-head fragment in the library came back this way: a face filling a
vertical frame, shoulders cropped, no torso. The file requirements say the same
thing for the video as for the picture — *clear head, shoulders, torso view* —
so a motion model that has no body to read the pose from has nothing to transfer.

Five variants of the request were sent — no `mode`, `720p`, `1080p`,
`background_source` either way — and all five failed identically, so the framing
of the source is what decides it, not the request. Refusals cost nothing, which
is what makes probing safe.

### One that landed

Same request, a source that shows head, shoulders and torso: accepted, and
**success in 125 s** — 4 s of 720×1280 at 30 fps, no audio stream.

What came back settles what this model actually does. The reference picture was a
woman on a night street; the reference video was a different person entirely, a
man talking indoors. The result is **the woman, in her night street, performing
the man's speech and head movement**. Motion Control does not paste a face onto
the footage: it animates the picture, and the video is only the choreography.

Two consequences for the tool:

* the anchor frame must be cut from **the same fragment** that provides the
  motion — then "animate the picture" and "keep the shot" are the same thing,
  which is exactly the face swap we want;
* `background_source: "input_video"` did not bring the video's room across; the
  scene stayed the picture's. Another reason the picture has to come from the
  fragment itself.

Billing, measured: **120 credits ≈ $0.60 for a 4 s fragment** at 720p. That is
ten seconds' worth at the list rate of 12 credits/s, so short fragments are
charged at a floor — or the rate is higher than the list says; one run cannot
tell which. The estimate in the panel takes the pessimistic reading,
`rate × max(10, length)`.

There is no 4K on this model: `4k`, `4K`, `2160p`, `1440p` and `480p` are all
answered "mode is not within the range of allowed options". Only 720p and 1080p
exist.

Downloading the result needs a `User-Agent`: `tempfile.aiquickdraw.com` answers
403 to a bare urllib request.
