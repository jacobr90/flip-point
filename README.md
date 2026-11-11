# Flip Point

A training app for the TechDisc v2 API. For every disc in your TechDisc bag, it finds the arm speed where the disc stops holding hyzer, flips up to flat, and flips over. It then grades each live throw against those speeds.

## Run it

Open `index.html` in a browser. To serve it locally instead:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1 -Root . -Port 8765
```

Then go to http://localhost:8765.

Without a token the app runs in demo mode with a sample bag and a rough built-in flight model. To use your real bag, paste a TechDisc play token in Settings. The token is stored only in your browser.

## How flip points are found

Each disc is simulated at 4 speeds from 20 to 85 mph from the same chart release, plus one extra speed near each flip point. The chart release has a hyzer angle (15° by default) and a nose angle (2° up by default, since most players throw a little nose up). Both adjust in 1° steps, and "Use my release" sets them to the average of your recent throws. From each simulated flight, the app reads the most anhyzer tilt before the late fade:

- +5° or more: still hyzer
- between +5° and −15°: flipped to flat
- −15° or less: flipped over

Each sweep flight also records its carry (straight-line distance from the tee to where it lands) and its left/right finish. That gives each disc an estimated **max carry** and the speed that produces it, the carry at your usual speed, and the carry range for each flight shape. Carry is for the chart's hyzer and nose angles, so it is an estimate to plan TechDisc simulator holes with, not a guarantee.

The flip points are where that tilt crosses those lines as speed rises. Mapping one disc uses at most 6 API requests and only runs when you ask, paced to stay under the API limits (60 per minute, 1,000 per hour).

## Files

- `js/api.js`: TechDisc v2 client
- `js/tilt.js`: reads disc tilt from simulated flights
- `js/flip.js`: speed sweep, flip-point math, request pacing, demo model
- `js/app.js`: interface
- `serve.ps1`: small local web server for Windows

## Nose check

For the disc in hand, the app can map the same disc once more with the nose 3° lower and show what changes: max carry, and the speeds where it flips to flat and flips over. This shows what learning a nose-down release is worth with each disc. It uses at most 6 more API calls and only runs when you press Compare.
