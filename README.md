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

Each disc is simulated at 9 speeds from 20 to 85 mph from the same reference release (15° hyzer by default, adjustable). From each simulated flight, the app reads the most anhyzer tilt before the late fade:

- +5° or more: still hyzer
- between +5° and −15°: flipped to flat
- −15° or less: flipped over

The flip points are where that tilt crosses those lines as speed rises. Mapping one disc uses about 9 API requests, paced to stay under the API limits (60 per minute, 1,000 per hour).

## Files

- `js/api.js`: TechDisc v2 client
- `js/tilt.js`: reads disc tilt from simulated flights
- `js/flip.js`: speed sweep, flip-point math, request pacing, demo model
- `js/app.js`: interface
- `serve.ps1`: small local web server for Windows
