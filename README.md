# BiasModel v2.5 — Live Demo

> **Instantly deployable demo** — no local GPU or Jan AI required.  
> Uses Gemini API for all pipeline stages.

🔗 **Live:** [biasmodel-demo.vercel.app](https://biasmodel-demo.vercel.app) *(update after deploy)*  
📦 **Demo repo:** [github.com/Mohit33222/biasmodel-demo](https://github.com/Mohit33222/biasmodel-demo)  
📦 **Full project:** [github.com/SayanSantra-t/unbaised_AI](https://github.com/SayanSantra-t/unbaised_AI)

---

## Deploy in 5 minutes

### 1. Backend → Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Go to [render.com](https://render.com) → New Web Service
2. Connect **github.com/Mohit33222/biasmodel-demo**, set **Root Directory** to `backend`
3. Add env var: `GEMINI_API_KEY = your_key`
4. Deploy — Render gives you a URL like `https://biasmodel-demo-api.onrender.com`

### 2. Frontend → Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

1. Import this repo on [vercel.com](https://vercel.com)
2. Add env var: `VITE_API_URL = https://biasmodel-demo-api.onrender.com`
3. Deploy — done!

---

## How it differs from the full version

| Feature | Demo (this repo) | Full version |
|---------|-----------------|--------------|
| Predictor | Gemini 2.0 Flash | Gemma-3-4B (local) |
| Auditor | Gemini 2.0 Flash | Gemma-3-4B (local) |
| Meta-Auditor | Gemini 2.0 Flash | Gemma-3-4B (local) |
| Supreme Auditor | Gemini 2.5 Flash | Gemini 2.5 Flash |
| GPU required | ❌ None | ✅ Jan AI + local GPU |
| API key needed | ✅ Gemini only | ✅ Gemini + Jan AI |
| ChromaDB memory | ✅ Yes | ✅ Yes |
| Batch CV upload | ✅ Yes | ✅ Yes |
| All 3 domains | ✅ Yes | ✅ Yes |

---

## Local run

```bash
# Backend
cd backend
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env   # add your GEMINI_API_KEY
python main.py

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```
