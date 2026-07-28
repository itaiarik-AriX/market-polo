# Station ambient loops — generation brief

Goal: while a visitor rests on a station and reads the copy, the background is
alive — waves rolling, grass moving in the wind — looping so smoothly nobody
notices it repeat.

These clips have to be **generated**, not cut from the existing footage. The
camera drifts 15–48 units per second at every station (measured as mean
frame-to-frame difference on a 0–255 scale); anything above ~6 cannot be looped
without a visible jump.

## Input plates

Use the plates in `docs/station-plates/` — one per station, 1920×1080.

Each is the **exact frame that station rests on**, so the generated loop's first
frame is what the scrub already shows and the handover is invisible. Do not
substitute a different frame, even a sharper one.

The burned-in tool marks have been removed from the plates by diffusion infill.
This matters: a hard white glyph in the input is an *object* to a video model,
and it will warp or animate it — far worse than a static mark.

## Settings for every station

| | |
|---|---|
| Duration | 4–6s (longer drifts more, and a few seconds is plenty to loop) |
| Camera motion | **off / none** — the single most important setting |
| Takes | 3–4 per station, keep the calmest |
| Loop mode | on, if the tool offers "match last frame to first" |

## Why the people stay frozen

At 12–13% of frame height they read as posture, not expression — "laughing and
talking" cannot land at that size. Meanwhile structured human motion is the one
thing that makes a loop's repeat detectable, because the eye learns a gesture's
arc and recognises the replay. Waves and grass have no arc to memorise.

Hands holding wine glasses are also exactly where AI video breaks down.

If a take moves them anyway, keep it — they can be masked back to the plate
afterwards while the motion is retained everywhere else. Judge takes on whether
the *waves and grass* look right.

Only welcome, exterior and closing contain people at all.

---

## 1 · Welcome — `1-welcome.png`

> Static locked-off camera. No camera movement of any kind. Only the environment
> moves: distant ocean waves roll in and break slowly along the shoreline; the
> foreground meadow of tall grasses and wildflowers sways gently in a light
> breeze, seed heads nodding and drifting; occasional petals stir. Warm
> golden-hour light stays constant. The seated couple remain completely frozen —
> no movement of their bodies, heads, arms or hands. The van remains completely
> still. Slow, calm, extremely subtle motion throughout.

**Negative:** camera pan, camera zoom, camera shake, dolly, parallax, people
moving, gesturing, turning heads, walking, vehicle moving, fast motion,
time-lapse, flickering, morphing, warping, text, watermark, logo

---

## 2 · Exterior — `2-exterior.png`

> Static locked-off camera, completely fixed framing. The sea behind the van
> moves gently — slow waves breaking against the cliffs. The clifftop grass
> around the van ripples softly in a light coastal breeze. Warm low sunlight
> remains steady. The van is completely motionless, doors and curtains still.
> The lone seated figure on the left is completely frozen, no movement at all.
> Very subtle, unhurried, ambient motion only.

**Negative:** camera movement, pan, zoom, shake, person moving, standing up,
walking, van moving, door opening, wheels turning, fast motion, flicker,
morphing, text, watermark

---

## 3 · Amenities — `3-amenities.png` *(interior, no people)*

> Static locked-off camera, fixed interior framing. Gentle interior life only:
> the hanging trailing plants sway very slightly as if in a soft draught; the
> string lights and lantern glow with a barely perceptible warm flicker; through
> the windscreen the distant sea moves slowly. All furniture, cushions, blankets
> and fittings remain perfectly still. Warm cosy evening light, constant
> exposure. Extremely subtle motion, nothing dramatic.

**Negative:** camera movement, pan, zoom, dolly, objects shifting, cushions
moving, blanket moving, doors opening, people, hands entering frame, fast
motion, strobing, morphing, text, watermark

---

## 4 · View — `4-view.png` *(rear hatch, no people)*

> Static locked-off camera, fixed framing. Through the open rear hatch the sunset
> ocean moves: slow rolling waves and shimmering golden light glinting across the
> water. The fringe of the knitted blanket stirs very slightly in a light sea
> breeze. Warm interior lamps hold a soft steady glow. The bed, book, glassware
> and all interior surfaces remain completely still. Calm, slow, subtle ambient
> motion.

**Negative:** camera movement, pan, zoom, tilt, objects moving, glasses moving,
liquid spilling, book pages turning, people, hands, fast motion, flicker,
morphing, text, watermark

---

## 5 · Closing — `5-closing.png` *(aerial — the hard one)*

> Completely static locked-off aerial shot. The drone does not move, hover,
> drift, rotate or descend — the framing is absolutely fixed. Only nature moves:
> ocean waves roll in and break along the shoreline far below, sunlight glitters
> across the water, and the clifftop grass and heather ripple gently in the
> breeze. The parked van is completely motionless. The couple on the blanket are
> completely frozen, no movement of any kind. Warm golden sunset light, constant.
> Slow, wide, tranquil, extremely subtle motion.

**Negative:** drone movement, aerial movement, flying, hovering, drifting,
orbiting, rotating, pan, tilt, zoom, descending, ascending, parallax, people
moving, van moving, fast motion, time-lapse, morphing, text, watermark

**Expect to fight this one.** Models associate aerial footage with flying, so it
needs the most attempts. If it keeps drifting, describing it as a non-aerial shot
("static wide shot from a clifftop looking down over the bay") sometimes gets it
to hold still.

---

## What happens next

Send the clips back and the remaining work is:

1. Score each clip for residual camera drift; reject any that moved.
2. Find the loop point — either a matched cut between the two most similar
   frames, or a crossfade of the last ~0.6s into the first. Crossfade suits
   stochastic motion (water, grass) because there is no trackable detail.
   Ping-pong is available but must **not** be used where people are visible;
   reversed human motion reads as wrong immediately.
3. Mask people back to the plate if a take moved them.
4. Encode per station, wire into the station hold where the sharp still sits now,
   play only the active station, fall back to the still under
   `prefers-reduced-motion`, and keep the still as the poster frame.
