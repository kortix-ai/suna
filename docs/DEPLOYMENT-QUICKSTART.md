# ⚡ Kortix Deployment - 5 Minute Quickstart

## 🎯 Just Tell Me What to Do

### For Most People → Use Render

**Why**: Easiest, fastest, zero configuration  
**Cost**: $180/month  
**Time**: 15 minutes  

```bash
# 1. Push your code to GitHub
git push origin main

# 2. Go to https://dashboard.render.com and sign up

# 3. Click "New +" → "Web Service"

# 4. Connect GitHub → Select your repo

# 5. Configure:
   - Name: kortix-backend
   - Environment: Docker
   - Docker Context: ./backend
   - Docker Command: (leave default)
   
# 6. Add Environment Variables (click "Advanced"):
   ENV_MODE=production
   SUPABASE_URL=your-supabase-url
   SUPABASE_ANON_KEY=your-key
   SUPABASE_SERVICE_ROLE_KEY=your-key
   ANTHROPIC_API_KEY=your-key
   TAVILY_API_KEY=your-key
   FIRECRAWL_API_KEY=your-key
   RAPID_API_KEY=your-key
   DAYTONA_API_KEY=your-key
   
# 7. Create another Web Service for frontend (same steps)

# 8. Add Redis from Render dashboard

# Done! Your app is live at: https://your-app.onrender.com
```

**That's it!** ✅

---

## 🤔 "But wait, I want to compare options first..."

### Quick Decision Flow

```
START: What matters most to you?

├─ "I need it deployed NOW"
│  └─→ Go with RENDER
│     Time: 15 min | Cost: $180/mo | Difficulty: ⭐
│
├─ "I want the LOWEST COST"
│  └─→ Go with FLY.IO
│     Time: 45 min | Cost: $108/mo | Difficulty: ⭐⭐
│
├─ "I'm planning for BIG SCALE"
│  └─→ Go with AWS ECS
│     Time: 4-8 hrs | Cost: $310/mo | Difficulty: ⭐⭐⭐⭐
│
└─ "I want FULL CONTROL"
   └─→ Go with SELF-HOSTED VPS
      Time: 2-4 hrs | Cost: $31/mo | Difficulty: ⭐⭐⭐⭐⭐
```

---

## 📊 The Only Comparison You Need

| What You Need | Platform | Cost | Time | Commands |
|--------------|----------|------|------|----------|
| **Easiest** | Render | $180/mo | 15 min | Click click done |
| **Cheapest** | Fly.io | $108/mo | 45 min | `flyctl launch` |
| **Most Scalable** | AWS ECS | $310/mo | 4 hrs | See AWS guide |
| **Most Control** | VPS | $31/mo | 2 hrs | `docker compose up` |
| **Best DX** | Railway | $145/mo | 30 min | `railway up` |

DX = Developer Experience

---

## 🚀 Platform-Specific Quickstarts

### Render (15 minutes) ⚡
```bash
1. Push to GitHub
2. dashboard.render.com → New Web Service
3. Connect repo
4. Add env vars
5. Deploy
Done!
```
**Best for**: Startups, non-technical founders, rapid prototyping

---

### Fly.io (45 minutes) 💰
```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login
flyctl launch
flyctl deploy
flyctl scale count 2
```
**Best for**: Cost-conscious developers, global distribution

---

### Railway (30 minutes) 🎨
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```
**Best for**: Developers who love great UX

---

### AWS ECS (4-8 hours) 🏢
```bash
# Too complex for quickstart
# See: docs/DEPLOYMENT-AWS.md
# Or hire DevOps consultant
```
**Best for**: Enterprise, serious scale, compliance needs

---

### Self-Hosted (2-4 hours) 🛠️
```bash
# Get VPS (hetzner.com - €28/mo)
ssh root@your-ip
curl -fsSL https://get.docker.com | sh
git clone https://github.com/your-org/kortix.git
cd kortix
cp backend/.env.example backend/.env
# Edit .env with your keys
docker compose up -d
```
**Best for**: Learning, full control, saving money

---

## 💸 What Will This Actually Cost?

### Reality Check

**Starting out (0-100 users)**:
- Render: $180/mo (everything included)
- Fly.io: $108/mo (everything included)
- Self-hosted: $31/mo (VPS only, you do the work)

**Growing (100-1K users)**:
- Render: $180-250/mo (may need to upgrade)
- Fly.io: $108-200/mo (scales smoothly)
- AWS ECS: $310-450/mo (auto-scales)
- Self-hosted: $96/mo (bigger VPS needed)

**Scaled (10K+ users)**:
- AWS ECS: $600-1200/mo (with auto-scaling)
- GCP: $700-1400/mo
- Self-hosted: $240-500/mo (multiple servers + your time)

**Hidden costs to remember**:
- Domain: $10-15/year
- Monitoring (optional): $0-50/mo
- Backups: Usually included
- Your time: Priceless 😉

---

## ⏱️ How Long Will This Take?

**Render (Recommended)**:
- Setup: 15 minutes
- First deploy: 10 minutes
- **Total: 25 minutes**

**Fly.io**:
- Install CLI: 5 minutes
- Configure: 20 minutes
- Deploy: 15 minutes
- **Total: 40 minutes**

**Railway**:
- Setup: 10 minutes
- Configure: 15 minutes
- Deploy: 10 minutes
- **Total: 35 minutes**

**AWS ECS**:
- Learn AWS: 2-4 hours (if new)
- Setup infrastructure: 2-3 hours
- Configure everything: 1-2 hours
- Debug issues: 1-2 hours
- **Total: 6-11 hours** (spread over days)

**Self-Hosted VPS**:
- Get VPS: 10 minutes
- SSH + Docker: 15 minutes
- Clone + Configure: 30 minutes
- Deploy: 20 minutes
- Nginx + SSL: 45 minutes
- Debug: 30 minutes
- **Total: 2.5 hours** (if you know what you're doing)

---

## 🎓 "I'm a complete beginner"

**Start here**:

1. **Watch this 5-min video** (coming soon): "Deploying Kortix to Render"

2. **Follow this checklist**:
   ```
   [ ] Create GitHub account (github.com)
   [ ] Push your code to GitHub
   [ ] Create Render account (render.com)
   [ ] Click "New Web Service"
   [ ] Connect GitHub
   [ ] Add environment variables
   [ ] Click "Create Web Service"
   [ ] Wait 5-10 minutes
   [ ] Visit your app URL
   [ ] 🎉 You're live!
   ```

3. **Get stuck? Join Discord**: https://discord.gg/Py6pCBUUPw

**Time investment**: 30-45 minutes  
**Cost**: $180/month  
**Difficulty**: Very Easy ⭐

---

## 🔥 "I'm experienced and want the best setup"

**Go with AWS ECS**:

1. Read: `docs/DEPLOYMENT-AWS.md` (comprehensive guide)
2. Setup: VPC, ECS, ElastiCache, ALB, CloudFront
3. Implement: CI/CD with GitHub Actions
4. Configure: Monitoring, auto-scaling, alerts
5. Test: Load testing, security audit

**Time investment**: 1-2 days  
**Cost**: $310-600/month  
**Difficulty**: Advanced ⭐⭐⭐⭐

**Bonus**: Full production-grade infrastructure, scales to millions

---

## 🎯 My Personal Recommendation

As someone who's deployed hundreds of apps:

**If you're a founder/startup**:
→ Use **Render**. Don't overthink it. Deploy in 15 minutes, iterate fast, migrate later if needed.

**If you're a developer**:
→ Use **Fly.io**. Great balance of cost, performance, and DX. Learn valuable skills.

**If you're a company (funding/revenue)**:
→ Use **AWS ECS**. It's complex but worth it. Scales forever, enterprise-grade.

**If you're learning**:
→ Use **Self-hosted VPS**. You'll learn Docker, Nginx, Linux, deployment. Valuable skills.

---

## 📚 Where to Learn More

**Just want to deploy**:
- `DEPLOYMENT-SUMMARY.md` ← Start here

**Comparing options**:
- `docs/DEPLOYMENT-DECISION-GUIDE.md` ← Decision matrices

**Platform guides**:
- `docs/DEPLOYMENT-OPTIONS.md` ← All platforms covered

**AWS deep dive**:
- `docs/DEPLOYMENT-AWS.md` ← Step-by-step AWS

**Interactive helper**:
```bash
python deploy.py
```
Asks questions, recommends platform

---

## ✅ Pre-Flight Checklist

Before deploying anywhere:

- [ ] Backend `.env` file configured
- [ ] Frontend `.env.local` configured
- [ ] Supabase project created
- [ ] Got at least 1 LLM API key (Anthropic/OpenAI)
- [ ] Got Tavily API key (search)
- [ ] Got Firecrawl API key (web scraping)
- [ ] Got Daytona API key (sandbox)
- [ ] Git repo pushed to GitHub
- [ ] Docker installed locally
- [ ] Tested locally with `docker compose up`

**Missing API keys?**
- Supabase: https://supabase.com (free tier available)
- Anthropic: https://console.anthropic.com
- Tavily: https://tavily.com
- Firecrawl: https://firecrawl.dev
- Daytona: https://daytona.io

---

## 🆘 Quick Troubleshooting

**"My deploy failed"**
→ Check platform logs, usually shows the error clearly

**"Environment variables not working"**
→ Make sure you're using platform-specific secrets manager, not .env files

**"App is slow"**
→ Enable Redis caching, check database indexes, add CDN

**"Out of memory"**
→ Increase memory allocation, check for leaks, optimize code

**"Can't connect to database"**
→ Verify Supabase URL/keys, check IP allowlist

**"I'm stuck and frustrated"**
→ Discord: https://discord.gg/Py6pCBUUPw (we're friendly!)

---

## 🎉 You're Ready to Deploy!

**3 ways to proceed**:

1. **Fastest** (15 min):
   ```
   Go to render.com → Deploy now
   ```

2. **Interactive** (10 min):
   ```bash
   python deploy.py
   ```

3. **Research first** (30 min):
   ```
   Read DEPLOYMENT-SUMMARY.md
   ```

**Remember**: Perfect is the enemy of shipped. Start with Render, you can always migrate later.

Good luck! 🚀

---

**Questions?**
- Discord: https://discord.gg/Py6pCBUUPw
- Email: support@kortix.ai
- Docs: https://docs.kortix.ai

**Found this helpful?**
⭐ Star us on GitHub: https://github.com/kortix-ai/suna


