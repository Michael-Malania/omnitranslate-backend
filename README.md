# OmniTranslate Shared Backend API

Centralized cloud backend for **OmniTranslate Live** across Desktop Native, Mobile (Android), and Web.

## 🌟 Key Features
- **Google Sign-In Authentication & Profile Sync**: Handles user sign-in and links usage profiles.
- **Developer Privilege Auto-Detection**: Pre-authorized developer emails (`malaniamichael@gmail.com`, etc.) automatically get unlimited access with metrics gating disabled.
- **Developer Simulation Switch**: Allows developers to toggle between unlimited mode and simulated free-tier mode to test the paywall experience.
- **Paywall & Quota Enforcement**: Tracks translations and locks non-paying users when the 15-translation trial quota is reached.
- **Cross-Platform Sync**: Works uniformly with Electron, Android Kotlin, and Web.

---

## 🚀 Running Locally

```bash
cd backend
npm install
npm run dev
```
The server will run on [http://localhost:5050](http://localhost:5050).

---

## ☁️ Deployment

- **Render.com**: Connect the GitHub repo and Render uses `render.yaml` automatically for free hosting.
- **Railway**: Connect repo, set root directory to `backend`, deploy.
- **Docker**: `docker build -t omnitranslate-backend . && docker run -p 5050:5050 omnitranslate-backend`
