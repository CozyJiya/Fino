# 💸 Expense Tracker — Space Modern v2.0

A single-page expense tracking web app with a dark "Space Modern" UI, built with Vanilla JS + Supabase (PostgreSQL).

---

## 📁 Project Structure

```
expense-tracker/
├── index.html          ← App shell & layout
├── style.css           ← Space Modern dark theme
├── config.js           ← 🔑 Your Supabase credentials go here
├── app.js              ← All app logic
├── supabase_setup.sql  ← Run once in Supabase SQL Editor
└── README.md
```

---

## 🗄️ Step 1 — Set Up Supabase

### 1.1 Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **"New Project"**.
3. Choose your organisation, give the project a name (e.g. `expense-tracker`), set a strong database password, and pick the region closest to you.
4. Click **"Create new project"** and wait ~2 minutes for it to boot.

---

### 1.2 Run the SQL Setup

1. In the Supabase sidebar, click **"SQL Editor"**.
2. Click **"New query"**.
3. Open the file `supabase_setup.sql` from this project.
4. Copy **all** of its contents and paste into the SQL Editor.
5. Click **"Run"** (or press `Ctrl+Enter` / `Cmd+Enter`).

This will:
- Create the `categories` table
- Create the `expenses` table (with a foreign key to `categories`)
- Add indexes for fast queries
- Seed 8 predefined categories (Food, Travel, Rent, etc.)
- Enable Row Level Security (RLS) with permissive policies for anonymous use

✅ You should see `Success. No rows returned` (or similar) with no errors.

---

### 1.3 Get Your API Keys

1. In the Supabase sidebar, go to **Project Settings → API**.
2. Copy two values:
   - **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
   - **anon / public key** — a long string starting with `eyJ...`

---

## ⚙️ Step 2 — Add Your Keys to the App

Open `config.js` and replace the placeholders:

```js
const SUPABASE_URL      = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

> ⚠️ **Security note:** The `anon` key is safe to expose in a public frontend as long as RLS is enabled (which `supabase_setup.sql` does). Never use the `service_role` key in frontend code.

---

## 🚀 Step 3 — Deploy to GitHub Pages

### 3.1 Push to GitHub

```bash
# In the expense-tracker folder:
git init
git add .
git commit -m "Initial commit — Expense Tracker v2.0"

# Create a new repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/expense-tracker.git
git branch -M main
git push -u origin main
```

### 3.2 Enable GitHub Pages

1. Go to your repo on GitHub.
2. Click **Settings → Pages** (in the left sidebar).
3. Under **"Source"**, select **Deploy from a branch**.
4. Choose `main` branch and `/ (root)` folder.
5. Click **Save**.

Your app will be live at:
```
https://YOUR_USERNAME.github.io/expense-tracker/
```

> It may take 1–2 minutes to first appear. Refresh after a moment.

---

## 🔐 Optional: Hide Your Keys (Recommended for Public Repos)

Since `config.js` contains your Supabase anon key, consider these options:

**Option A — Add to `.gitignore`** (simplest):
```
# .gitignore
config.js
```
Then each person who clones the repo must create their own `config.js`. Ship a `config.example.js` with placeholders instead.

**Option B — GitHub Actions + Secrets** (for CI/CD):
1. Go to repo **Settings → Secrets and variables → Actions**.
2. Add secrets: `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Add a workflow that injects them into `config.js` at build time.

---

## ✨ Features

| Feature | Details |
|---|---|
| Add / Edit / Delete expenses | Full CRUD with Supabase |
| Searchable category pills | Predefined + custom categories |
| Stats bar | Total, monthly spend, daily average |
| Daily bar chart | Chart.js — Pink Lavender bars |
| Category pie chart | Clickable slices filter the list |
| Monthly summary table | All-time month-by-month view |
| Slide-over edit panel | Smooth right-panel animation |
| Delete confirmation dialog | Prevents accidental deletes |
| Toast notifications | Success + error feedback |
| Responsive layout | Desktop, tablet, mobile |
| WCAG 2.1 AA | Dark theme contrast compliant |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JS |
| Database / Backend | Supabase (PostgreSQL) |
| Charts | Chart.js 4 (CDN) |
| Fonts | Space Grotesk + DM Mono (Google Fonts) |
| Hosting | GitHub Pages |

---

## 🗺️ Roadmap (Out of Scope for v1)

- [ ] Multi-user login
- [ ] Export to PDF / CSV
- [ ] Budget limits & alerts
- [ ] Recurring expenses
- [ ] Native mobile app
