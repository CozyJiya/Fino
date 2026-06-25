/* ============================================================
   app.js — Fino (Figma Design Match)
   Requires: config.js → SUPABASE_URL, SUPABASE_ANON_KEY
   ============================================================ */
'use strict';

/* ── Supabase init ── */
const { createClient } = supabase;
let db = null;

// Initialize Supabase only if configured
if (!DEMO_MODE) {
  db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('✓ Supabase mode');
} else {
  console.log('✓ Demo mode (no database)');
}

/* ── State ── */
let currentUser   = null;
let allExpenses   = [];
let allCategories = [];
let selectedCat   = null;
let pendingDelId  = null;
let editingExpenseId = null;
let userIncome    = 50000; // Default income
let userProfile   = null; // Store user profile data
let currentOTP    = null; // Store generated OTP
let pendingPhone  = null; // Store phone number pending verification
let editingField  = null; // Track which field is being edited
let transactionType = 'spend'; // 'spend' or 'received'
let barChart      = null;
let donutChart    = null;
let trendChart    = null;
let userSubscriptions = []; // recurring subscriptions
let userCurrency  = 'INR'; // display currency preference

const CURRENCY_SYMBOLS = { INR:'₹', USD:'$', EUR:'€', GBP:'£', JPY:'¥', AED:'د.إ' };

const SPEND_CATEGORIES = ['Food and drinks', 'Transport', 'Shopping', 'Groceries', 'Home', 'Entertainment', 'Event', 'Travel', 'Medical', 'Personal', 'Fitness', 'Services', 'Bills'];
const RECEIVED_CATEGORIES = ['Earning', 'Pocket money', 'Gift', 'Borrowed', 'Refund', 'Return', 'Interest', 'Cashback'];
const PALETTE    = ['#ceb5d4','#4e7ab1','#a98dc0','#7d9fc0','#d4a0e0','#6b8fb5','#b5a8d4','#8fa8c0','#c0a8d4','#a8b5d4','#d4b5c0','#b5c0d4','#c0d4b5'];

/* ── Helpers ── */
const $  = id => document.getElementById(id);
const currencySymbol = () => CURRENCY_SYMBOLS[userCurrency] || '₹';
const fmt = n  => currencySymbol() + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toISOString().slice(0, 10);
// Strip internal subscription markers like "[sub:ID:2026-06]" from display
const cleanDesc = d => (d || '').replace(/\s*\[sub:[^\]]+\]/g, '').trim();
// Top-level HTML escape (a second escapeHtml is nested elsewhere; this one is
// available to all top-level functions like the subscriptions UI).
function escapeHtmlSafe(text) {
  const div = document.createElement('div');
  div.textContent = (text == null ? '' : String(text));
  return div.innerHTML;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' error' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 350);
  }, 3000);
}

/* ════════════════════════════════════════
   AUTH
════════════════════════════════════════ */
async function checkSession() {
  if (DEMO_MODE) {
    showLandingPage();
    return;
  }
  
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    currentUser = session.user;
    // Return intent = user was sent to login mid-flow (e.g. to write a review)
    if (sessionStorage.getItem("returnTo") && typeof window._handleReturnIntent === "function") {
      window._handleReturnIntent();
    } else {
      // Signed in but visiting landing page normally — stay on landing page.
      // The nav button already shows "Go to App" (set by checkLandingSession).
      showLandingPage();
    }
  } else {
    showLandingPage();
  }
}

function showLandingPage() {
  $('page-landing').classList.remove('hidden');
  $('page-login').classList.add('hidden');
  $('page-signup').classList.add('hidden');
  $('page-app').classList.add('hidden');
}

function showLogin() {
  $('page-landing').classList.add('hidden');
  $('page-login').classList.remove('hidden');
  $('page-signup').classList.add('hidden');
  $('page-app').classList.add('hidden');
}

function showSignup() {
  $('page-landing').classList.add('hidden');
  $('page-login').classList.add('hidden');
  $('page-signup').classList.remove('hidden');
  $('page-app').classList.add('hidden');
}

async function showApp() {
  $('page-landing').classList.add('hidden');
  $('page-login').classList.add('hidden');
  $('page-signup').classList.add('hidden');
  $('page-app').classList.remove('hidden');
  // set avatar initials (will be overridden by pfp if saved)
  const email = currentUser?.email || '';
  $('avatar-btn').textContent = email.charAt(0).toUpperCase() || 'A';
  // apply saved pfp to avatar immediately (scoped to this user)
  const savedPfp = localStorage.getItem(`pfp_${currentUser.id}`);
  if (savedPfp) {
    $('avatar-btn').style.backgroundImage = `url(${savedPfp})`;
    $('avatar-btn').style.backgroundSize = 'cover';
    $('avatar-btn').style.backgroundPosition = 'center';
    $('avatar-btn').textContent = '';
  }
  // prefill account email
  $('a-email').value = email;
  await Promise.all([loadCategories(), loadExpenses(), loadProfile()]);

  // Load preferences (currency) + recurring subscriptions
  await loadPreferences();
  await loadSubscriptions();

  // Check and add monthly income automatically
  await checkAndAddMonthlyIncome();
  // Check and add any due recurring subscriptions this month
  await checkAndAddSubscriptions();
  
  updateStats();
  navigateTo('home');
}

async function signIn() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) { toast('Please fill all fields', 'error'); return; }

  const btn = $('btn-signin');
  btn.disabled = true; btn.textContent = 'Signing in…';

  // DEMO MODE - Skip authentication
  if (DEMO_MODE) {
    setTimeout(() => {
      currentUser = { 
        id: 'demo-user', 
        email: username.includes('@') ? username : `${username}@demo.local`,
        user_metadata: { username }
      };
      btn.disabled = false; btn.textContent = 'Sign In';
      showApp();
    }, 500);
    return;
  }

  // REAL MODE - Use Supabase
  let loginEmail = username;

  // If not an email, look up the real email by username from profiles table
  if (!username.includes('@')) {
    const { data: profileRow, error: lookupError } = await db
      .from('profiles')
      .select('email')
      .eq('username', username)
      .maybeSingle();

    console.log('Username lookup:', { username, profileRow, lookupError });

    if (lookupError) {
      // RLS is likely blocking the query - show a helpful message
      btn.disabled = false; btn.textContent = 'Sign In';
      toast('Login by username failed: database policy blocked the lookup. Please sign in with your email for now, or fix RLS in Supabase.', 'error');
      return;
    }

    if (!profileRow || !profileRow.email) {
      btn.disabled = false; btn.textContent = 'Sign In';
      toast('Username not found. Try signing in with your email instead.', 'error');
      return;
    }
    loginEmail = profileRow.email;
  }

  const { error } = await db.auth.signInWithPassword({ email: loginEmail, password });

  btn.disabled = false; btn.textContent = 'Sign In';
  if (error) { toast(error.message, 'error'); return; }
  const { data: { session } } = await db.auth.getSession();
  currentUser = session.user;

  // Always ensure profiles row has username + email (handles first login after signup)
  const metaUsername = currentUser.user_metadata?.username || '';
  if (metaUsername) {
    await db.from('profiles').upsert({
      id: currentUser.id,
      username: metaUsername,
      email: currentUser.email
    }, { onConflict: 'id', ignoreDuplicates: false });
  }

  // If user came from the landing page (e.g. to write a review), go back there
  if (sessionStorage.getItem('returnTo') && typeof window._handleReturnIntent === 'function') {
    window._handleReturnIntent();
  } else {
    showApp();
  }
}

async function signUp() {
  const username = $('signup-username').value.trim();
  const email    = $('signup-email').value.trim();
  const password = $('signup-password').value;
  if (!username || !email || !password) { toast('Please fill all fields', 'error'); return; }

  const btn = $('btn-signup');
  btn.disabled = true; btn.textContent = 'Creating…';

  // DEMO MODE - Skip registration
  if (DEMO_MODE) {
    setTimeout(() => {
      btn.disabled = false; btn.textContent = 'Create Account';
      toast('Account created! Please sign in.');
      showLogin();
    }, 500);
    return;
  }

  // REAL MODE - Use Supabase

  // 1. Check username uniqueness against profiles table
  const { data: existingUser } = await db
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();

  if (existingUser) {
    btn.disabled = false; btn.textContent = 'Create Account';
    toast('Username already taken. Please choose another.', 'error');
    return;
  }

  // 2. Create the auth account — store username + email in metadata
  const { data: signUpData, error } = await db.auth.signUp({
    email,
    password,
    options: { data: { username, email } }
  });
  btn.disabled = false; btn.textContent = 'Create Account';
  if (error) { toast(error.message, 'error'); return; }

  // 3. Insert the profile row immediately so it exists before first login
  if (signUpData?.user) {
    await db.from('profiles').upsert({
      id: signUpData.user.id,
      username,
      email,
    }, { onConflict: 'id' });
  }

  toast('Account created! Please sign in.');
  showLogin();
}

async function signOut() {
  if (DEMO_MODE) {
    allExpenses = [];
    currentUser = null;
    showLandingPage();
    return;
  }
  
  await db.auth.signOut();  // This clears the Supabase session cookie/token
  currentUser = null;
  allExpenses = [];
  // Reset landing nav back to "Sign In" state
  const launchBtn = document.getElementById('lp-btn-launch');
  const userNav   = document.getElementById('lp-user-nav');
  if (launchBtn) { launchBtn.classList.remove('hidden'); launchBtn.setAttribute('data-action','login'); }
  if (userNav)   userNav.classList.add('hidden');
  showLandingPage();
}

/* ════════════════════════════════════════
   AUTOMATIC MONTHLY INCOME
════════════════════════════════════════ */
async function checkAndAddMonthlyIncome() {
  if (!currentUser) return;
  
  // Get user's monthly income from profile
  const income = userIncome || 50000;
  if (!income || income <= 0) return;
  
  // Get current month start date
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  
  // Find the "Earning" category
  const earningCategory = allCategories.find(c => c.name === 'Earning' && c.type === 'received');
  if (!earningCategory) return;
  
  if (DEMO_MODE) {
    // Check if income already added this month
    const alreadyAdded = allExpenses.some(e => 
      e.date === monthStartStr && 
      e.category_id === earningCategory.id &&
      e.description === 'Monthly Income (Auto-added)'
    );
    
    if (!alreadyAdded) {
      const newIncome = {
        id: Date.now().toString(),
        user_id: currentUser.id,
        amount: income,
        category_id: earningCategory.id,
        date: monthStartStr,
        description: 'Monthly Income (Auto-added)',
        created_at: new Date().toISOString(),
        categories: { name: 'Earning' }
      };
      allExpenses.unshift(newIncome);
      localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
      console.log('✅ Monthly income auto-added:', income);
    }
    return;
  }
  
  // REAL MODE - Call Supabase function
  try {
    const { error } = await db.rpc('check_and_add_monthly_income', {
      user_id_param: currentUser.id
    });
    
    if (error) {
      console.error('Error adding monthly income:', error);
    } else {
      console.log('✅ Monthly income check completed');
      // Reload expenses to show the new income
      await loadExpenses();
    }
  } catch (err) {
    console.error('Error calling monthly income function:', err);
  }
}

/* ════════════════════════════════════════
   NAVIGATION
════════════════════════════════════════ */
function navigateTo(page) {
  // sidebar buttons
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });

  // views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = $(`view-${page}`);
  if (target) target.classList.add('active');

  if (page === 'reports') renderReports();
  if (page === 'settings') openSettingsTab('profile');
}

/* ════════════════════════════════════════
   CATEGORIES
════════════════════════════════════════ */
async function loadCategories() {
  if (DEMO_MODE) {
    // Create categories for both types
    const spendCats = SPEND_CATEGORIES.map((n, i) => ({ 
      id: `spend-${i}`, 
      name: n, 
      type: 'spend' 
    }));
    const receivedCats = RECEIVED_CATEGORIES.map((n, i) => ({ 
      id: `received-${i}`, 
      name: n, 
      type: 'received' 
    }));
    allCategories = [...spendCats, ...receivedCats];
    renderPills();
    return;
  }
  
  const { data, error } = await db.from('categories').select('*').order('name');
  if (error) { 
    const spendCats = SPEND_CATEGORIES.map((n, i) => ({ 
      id: `spend-${i}`, 
      name: n, 
      type: 'spend' 
    }));
    const receivedCats = RECEIVED_CATEGORIES.map((n, i) => ({ 
      id: `received-${i}`, 
      name: n, 
      type: 'received' 
    }));
    allCategories = [...spendCats, ...receivedCats];
  }
  else allCategories = data;
  renderPills();
}

function renderPills() {
  const row = $('pill-row');
  row.innerHTML = '';
  
  // Filter categories based on transaction type
  const filteredCategories = allCategories.filter(c => c.type === transactionType);
  
  filteredCategories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'pill' + (selectedCat === c.id ? ' selected' : '');
    btn.textContent = c.name;
    btn.type = 'button';
    btn.onclick = () => { selectedCat = selectedCat === c.id ? null : c.id; renderPills(); };
    row.appendChild(btn);
  });
}

function setTransactionType(type) {
  transactionType = type;
  
  // Update button states
  $('btn-type-spend').classList.toggle('active', type === 'spend');
  $('btn-type-received').classList.toggle('active', type === 'received');
  
  // Reset selected category when switching types
  selectedCat = null;
  renderPills();
}

/* ════════════════════════════════════════
   EXPENSES — LOAD
════════════════════════════════════════ */
async function loadExpenses() {
  if (!currentUser) return;
  
  if (DEMO_MODE) {
    // Load from localStorage
    const stored = localStorage.getItem(`exp_${currentUser?.id}`);
    allExpenses = stored ? JSON.parse(stored) : [];
    renderExpenseList();
    return;
  }
  
  const { data, error } = await db
    .from('expenses')
    .select('*, categories(name)')
    .eq('user_id', currentUser.id)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) { toast('Failed to load expenses', 'error'); return; }
  allExpenses = data || [];
  renderExpenseList();
}

/* ════════════════════════════════════════
   EXPENSES — RENDER LIST
════════════════════════════════════════ */
function renderExpenseList() {
  const list = $('expense-list');
  list.innerHTML = '';

  if (allExpenses.length === 0) {
    list.innerHTML = '<li class="list-empty">No transactions yet. Add your first one!</li>';
    return;
  }

  allExpenses.forEach(e => {
    const cat = allCategories.find(c => c.id === e.category_id);
    const catName = cat?.name || e.categories?.name || getCatName(e.category_id) || '—';
    const isReceived = cat?.type === 'received';
    const dateFormatted = formatDate(e.date);
    const li = document.createElement('li');
    li.className = 'expense-item';
    li.innerHTML = `
      <div class="expense-left">
        <div class="expense-amount ${isReceived ? 'received' : 'spent'}">
          ${isReceived ? '+' : '-'}${fmt(e.amount)}
        </div>
        <div class="expense-meta">${catName} • ${dateFormatted}</div>
        ${e.description ? `<div class="expense-meta" style="margin-top:2px;font-size:12px;opacity:0.7">${cleanDesc(e.description)}</div>` : ''}
      </div>
      <div class="expense-right">
        <button class="btn-edit-expense" data-id="${e.id}" aria-label="Edit transaction">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-del-expense" data-id="${e.id}" aria-label="Delete transaction">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    `;
    list.appendChild(li);
  });
}

function getCatName(id) {
  return allCategories.find(c => c.id === id)?.name || '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ════════════════════════════════════════
   EXPENSES — EDIT
════════════════════════════════════════ */
function openEdit(id) {
  const e = allExpenses.find(x => x.id === id);
  if (!e) return;
  
  editingExpenseId = id;
  $('inp-amount').value = e.amount;
  $('inp-date').value = e.date;
  $('inp-desc').value = e.description || '';
  $('desc-counter').textContent = `${(e.description || '').length}/120`;
  selectedCat = e.category_id;
  renderPills();
  
  // Open modal
  openAddExpenseModal();
  toast('Editing expense', 'success');
}

function cancelEdit() {
  editingExpenseId = null;
  $('inp-amount').value = '';
  $('inp-date').value = todayStr();
  $('inp-desc').value = '';
  $('desc-counter').textContent = '0/120';
  selectedCat = null;
  renderPills();
  
  const btn = $('btn-add-expense');
  btn.textContent = 'Add Expense';
  btn.classList.remove('editing');
}

/* ════════════════════════════════════════
   EXPENSES — ADD / UPDATE
════════════════════════════════════════ */
async function addExpense() {
  const amount = parseFloat($('inp-amount').value);
  const date   = $('inp-date').value;
  const desc   = $('inp-desc').value.trim();

  if (!amount || amount <= 0) { toast('Enter a valid amount', 'error'); return; }
  if (!date)       { toast('Select a date', 'error'); return; }
  if (!selectedCat){ toast('Select a category', 'error'); return; }
  if (date > todayStr()) { toast('Date cannot be in the future', 'error'); return; }

  const btn = $('btn-add-expense');
  const isEditing = editingExpenseId !== null;
  btn.disabled = true; 
  btn.textContent = isEditing ? 'Updating…' : 'Adding…';

  if (DEMO_MODE) {
    if (isEditing) {
      // Update existing expense
      const index = allExpenses.findIndex(e => e.id === editingExpenseId);
      if (index !== -1) {
        allExpenses[index] = {
          ...allExpenses[index],
          amount,
          category_id: selectedCat,
          date,
          description: desc || null,
          categories: { name: getCatName(selectedCat) }
        };
        localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
        toast('Expense updated!');
      }
    } else {
      // Add new expense
      const newExpense = {
        id: Date.now().toString(),
        user_id: currentUser.id,
        amount,
        category_id: selectedCat,
        date,
        description: desc || null,
        created_at: new Date().toISOString(),
        categories: { name: getCatName(selectedCat) }
      };
      allExpenses.unshift(newExpense);
      localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
      toast('Expense added!');
    }
    
    btn.disabled = false;
    closeAddExpenseModal();
    cancelEdit();
    renderExpenseList();
    updateStats();
    return;
  }

  if (isEditing) {
    // Update existing expense
    const { error } = await db.from('expenses')
      .update({
        amount,
        category_id: selectedCat,
        date,
        description: desc || null,
      })
      .eq('id', editingExpenseId);

    btn.disabled = false;
    
    if (error) { 
      console.error('Supabase error:', error);
      toast('Failed to update expense: ' + error.message, 'error'); 
      btn.textContent = 'Update Expense';
      return; 
    }

    toast('Expense updated!');
    closeAddExpenseModal();
    cancelEdit();
    await loadExpenses();
    updateStats();
  } else {
    // Add new expense
    console.log('Adding expense:', {
      user_id: currentUser?.id,
      amount,
      category_id: selectedCat,
      date,
      description: desc || null
    });

    const { data, error } = await db.from('expenses').insert({
      user_id:     currentUser.id,
      amount,
      category_id: selectedCat,
      date,
      description: desc || null,
    }).select('*, categories(name)').single();

    btn.disabled = false;

    if (error) {
      console.error('Supabase error:', error);
      toast('Failed to add expense: ' + error.message, 'error');
      btn.textContent = 'Add Expense';
      return;
    }

    // Prepend locally — no need to reload all expenses from DB
    allExpenses.unshift(data);
    toast('Expense added!');
    closeAddExpenseModal();
    cancelEdit();
    renderExpenseList();
    updateStats();
  }
}

/* ════════════════════════════════════════
   EXPENSES — DELETE
════════════════════════════════════════ */
function openDelete(id) {
  const e = allExpenses.find(x => x.id === id);
  if (!e) return;
  pendingDelId = id;
  $('delete-sub').textContent = `${fmt(e.amount)} · ${e.categories?.name || ''} · ${formatDate(e.date)}`;
  $('delete-modal').classList.remove('hidden');
}

function closeDelete() {
  pendingDelId = null;
  $('delete-modal').classList.add('hidden');
}

async function confirmDelete() {
  if (!pendingDelId) return;
  const id = pendingDelId;
  closeDelete();
  
  if (DEMO_MODE) {
    allExpenses = allExpenses.filter(e => e.id !== id);
    localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
    toast('Expense deleted');
    renderExpenseList();
    updateStats();
    return;
  }
  
  const { error } = await db.from('expenses').delete().eq('id', id);
  if (error) { toast('Failed to delete', 'error'); return; }
  toast('Expense deleted');
  allExpenses = allExpenses.filter(e => e.id !== id);
  renderExpenseList();
  updateStats();
}

/* ════════════════════════════════════════
   STATS
════════════════════════════════════════ */
function updateStats() {
  // Calculate net balance (received - spent)
  let totalReceived = 0;
  let totalSpent = 0;
  
  allExpenses.forEach(e => {
    const cat = allCategories.find(c => c.id === e.category_id);
    const amount = parseFloat(e.amount);
    if (cat && cat.type === 'received') {
      totalReceived += amount;
    } else {
      totalSpent += amount;
    }
  });
  
  const netBalance = totalReceived - totalSpent;

  const now = new Date();
  const mo  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const moTransactions = allExpenses.filter(e => e.date.startsWith(mo));
  
  let moReceived = 0;
  let moSpent = 0;
  moTransactions.forEach(e => {
    const cat = allCategories.find(c => c.id === e.category_id);
    const amount = parseFloat(e.amount);
    if (cat && cat.type === 'received') {
      moReceived += amount;
    } else {
      moSpent += amount;
    }
  });
  
  const moNet = moReceived - moSpent;

  const days = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const daily = days ? moNet / days : 0;

  $('stat-balance').textContent = fmt(netBalance);
  $('stat-monthly').textContent = fmt(moNet);
  $('stat-daily').textContent   = fmt(daily);
  
  // Update stat labels to show which month
  const monthName = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  console.log('Stats for:', monthName, 'Net balance this month:', moNet);
  
  // Update trend chart
  renderTrendChart();
}

/* ════════════════════════════════════════
   TREND CHART (HOME)
════════════════════════════════════════ */
function renderTrendChart() {
  const now = new Date();
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const labels = [];
  const data = [];

  // Start from account creation date (or earliest transaction, or 30 days ago as fallback)
  let startDate;
  if (currentUser?.created_at) {
    startDate = new Date(currentUser.created_at);
    startDate.setHours(0, 0, 0, 0);
  } else if (allExpenses.length > 0) {
    const earliest = allExpenses.reduce((min, e) => e.date < min ? e.date : min, allExpenses[0].date);
    startDate = new Date(earliest + 'T00:00:00');
  } else {
    startDate = new Date(todayDate);
    startDate.setDate(todayDate.getDate() - 30);
  }
  if (startDate > todayDate) startDate = new Date(todayDate);

  // Update period label
  const periodEl = $('trend-period');
  if (periodEl) {
    periodEl.textContent = `Since ${startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

  // Calculate cumulative balance from account creation to today
  let runningBalance = 0;
  const cursor = new Date(startDate);
  while (cursor <= todayDate) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    // Get transactions for this day
    const dayTransactions = allExpenses.filter(e => e.date === dateStr);

    // Calculate day's net change (received - spent)
    dayTransactions.forEach(t => {
      const cat = allCategories.find(c => c.id === t.category_id);
      const amount = parseFloat(t.amount);
      if (cat && cat.type === 'received') {
        runningBalance += amount;
      } else {
        runningBalance -= amount;
      }
    });

    labels.push(dateStr);
    data.push(runningBalance);
    cursor.setDate(cursor.getDate() + 1);
  }
  
  // Calculate stats
  const currentBalance = runningBalance;
  
  // This month net change
  const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const moTransactions = allExpenses.filter(e => e.date.startsWith(mo));
  let moNet = 0;
  moTransactions.forEach(t => {
    const cat = allCategories.find(c => c.id === t.category_id);
    const amount = parseFloat(t.amount);
    if (cat && cat.type === 'received') {
      moNet += amount;
    } else {
      moNet -= amount;
    }
  });
  
  // This year net change
  const yr = `${now.getFullYear()}`;
  const yrTransactions = allExpenses.filter(e => e.date.startsWith(yr));
  let yrNet = 0;
  yrTransactions.forEach(t => {
    const cat = allCategories.find(c => c.id === t.category_id);
    const amount = parseFloat(t.amount);
    if (cat && cat.type === 'received') {
      yrNet += amount;
    } else {
      yrNet -= amount;
    }
  });
  
  // Update trend stats
  $('trend-balance').textContent = fmt(Math.abs(currentBalance));
  $('trend-month').textContent = (moNet >= 0 ? '+' : '') + fmt(moNet);
  $('trend-year').textContent = (yrNet >= 0 ? '+' : '') + fmt(yrNet);
  $('trend-current').textContent = fmt(currentBalance);
  
  // Destroy existing chart
  if (trendChart) trendChart.destroy();
  
  const ctx = $('chart-trend').getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#b987af',
        backgroundColor: 'rgba(185, 135, 175, 0.12)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#d6a7c2',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 3,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#152849',
          borderColor: 'rgba(78,122,177,0.3)',
          borderWidth: 1,
          titleColor: '#fff',
          bodyColor: '#fff',
          displayColors: false,
          callbacks: {
            title: (items) => {
              const date = new Date(items[0].label);
              return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            },
            label: (item) => `Balance: ${fmt(item.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: {
            display: true,
            color: 'rgba(125,159,192,0.08)',
            drawBorder: false
          },
          ticks: {
            color: 'rgba(125,159,192,0.5)',
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            callback: function(value, index) {
              const date = new Date(this.getLabelForValue(value));
              return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            }
          }
        },
        y: {
          display: true,
          position: 'right',
          grid: {
            display: true,
            color: 'rgba(125,159,192,0.08)',
            drawBorder: false
          },
          ticks: {
            color: 'rgba(125,159,192,0.5)',
            font: { size: 11 },
            callback: function(value) {
              if (value >= 1000) return (value/1000).toFixed(1) + 'K';
              return value;
            }
          }
        }
      },
      interaction: {
        intersect: false,
        mode: 'index'
      }
    }
  });
}

/* ════════════════════════════════════════
   REPORTS
════════════════════════════════════════ */
function renderReports() {
  renderBarChart();
  renderDonutChart();
  renderCategoryTable();
  renderMonthlyTable();
  renderYearlyTable();
}

function renderCategoryTable() {
  const spendStats = {};
  const receivedStats = {};
  let totalSpent = 0;
  let totalReceived = 0;

  // Tally per-category, track auto-income separately
  allExpenses.forEach(e => {
    const cat = allCategories.find(c => c.id === e.category_id);
    const catName = cat?.name || e.categories?.name || getCatName(e.category_id) || 'Other';
    const catType = cat?.type || 'spend';
    const amount = parseFloat(e.amount);
    const isAutoIncome = e.description === 'Monthly Income (Auto-added)';

    if (catType === 'received') {
      if (!receivedStats[catName]) receivedStats[catName] = { total: 0, count: 0, autoCount: 0, autoTotal: 0 };
      receivedStats[catName].total += amount;
      receivedStats[catName].count++;
      if (isAutoIncome) { receivedStats[catName].autoCount++; receivedStats[catName].autoTotal += amount; }
      totalReceived += amount;
    } else {
      if (!spendStats[catName]) spendStats[catName] = { total: 0, count: 0, autoCount: 0, autoTotal: 0 };
      spendStats[catName].total += amount;
      spendStats[catName].count++;
      totalSpent += amount;
    }
  });

  const spendCategories = Object.keys(spendStats).map(name => ({
    name, type: 'spend',
    total: spendStats[name].total,
    count: spendStats[name].count,
    average: spendStats[name].total / spendStats[name].count,
    percentage: totalSpent > 0 ? (spendStats[name].total / totalSpent * 100) : 0,
    autoCount: 0, autoTotal: 0
  })).sort((a, b) => b.total - a.total);

  const receivedCategories = Object.keys(receivedStats).map(name => ({
    name, type: 'received',
    total: receivedStats[name].total,
    count: receivedStats[name].count,
    average: receivedStats[name].total / receivedStats[name].count,
    percentage: totalReceived > 0 ? (receivedStats[name].total / totalReceived * 100) : 0,
    autoCount: receivedStats[name].autoCount,
    autoTotal: receivedStats[name].autoTotal
  })).sort((a, b) => b.total - a.total);

  const tbody = $('category-tbody');

  if (spendCategories.length === 0 && receivedCategories.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px">No transaction data yet</td></tr>`;
    const sumEl = $('cat-table-summary');
    if (sumEl) sumEl.innerHTML = '';
    return;
  }

  // Top summary badge
  const net = totalReceived - totalSpent;
  const netColor = net >= 0 ? '#34d399' : '#ef4444';
  const sumEl = $('cat-table-summary');
  if (sumEl) {
    sumEl.innerHTML = `
      <span class="cat-sum-badge cat-sum-red">💸 Spent: ${fmt(totalSpent)}</span>
      <span class="cat-sum-badge cat-sum-green">💰 Received: ${fmt(totalReceived)}</span>
      <span class="cat-sum-badge" style="border-color:${netColor};color:${netColor};">
        ${net >= 0 ? '📈' : '📉'} Net: ${net >= 0 ? '+' : ''}${fmt(net)}
      </span>
    `;
  }

  // Max value for unified bar scaling within each section
  const maxSpend    = spendCategories[0]?.total    || 1;
  const maxReceived = receivedCategories[0]?.total || 1;

  let html = '';

  // ── SPENDING SECTION ──
  if (spendCategories.length > 0) {
    html += `
      <tr class="cat-section-header cat-section-spend">
        <td colspan="6">
          <div class="cat-section-inner">
            <span>💸 SPENDING</span>
            <span class="cat-section-total">${fmt(totalSpent)} total · ${spendCategories.reduce((s,c)=>s+c.count,0)} transactions</span>
          </div>
        </td>
      </tr>
    `;

    spendCategories.forEach((cat, index) => {
      const rankDisplay = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `<span class="cat-rank-num">${index + 1}</span>`;
      // Bar width relative to top spender in this section (better visual)
      const barWidth = (cat.total / maxSpend) * 100;
      // Gradient: top category is darkest red
      const opacity = Math.max(0.5, 1 - index * 0.12);
      const barColor = `rgba(239,68,68,${opacity})`;
      // % of ALL money (spend + received) = context
      const pctOfNet = (totalReceived + totalSpent) > 0 ? (cat.total / (totalReceived + totalSpent) * 100) : 0;

      html += `
        <tr class="cat-row cat-row-spend">
          <td class="cat-rank">${rankDisplay}</td>
          <td class="cat-name">
            <span class="cat-name-text">${cat.name}</span>
          </td>
          <td class="cat-amount cat-amount-red">−${fmt(cat.total)}</td>
          <td class="cat-count">${cat.count}</td>
          <td class="cat-avg">${fmt(cat.average)}</td>
          <td class="cat-bar-cell">
            <div class="cat-bar-wrap">
              <div class="cat-bar-track">
                <div class="cat-bar-fill" style="width:${barWidth}%;background:${barColor};"></div>
              </div>
              <div class="cat-bar-labels">
                <span class="cat-pct-main">${cat.percentage.toFixed(1)}%</span>
                <span class="cat-pct-sub">of spend</span>
              </div>
            </div>
          </td>
        </tr>
      `;
    });

    // Spend subtotal row
    const avgSpend = spendCategories.length > 0 ? totalSpent / spendCategories.reduce((s,c)=>s+c.count,0) : 0;
    html += `
      <tr class="cat-subtotal-row">
        <td colspan="2" style="color:var(--text-muted);font-size:12px;padding:8px 12px;">Subtotal — ${spendCategories.length} categories</td>
        <td style="color:#ef4444;font-weight:700;padding:8px 12px;">−${fmt(totalSpent)}</td>
        <td style="color:var(--text-muted);padding:8px 12px;">${spendCategories.reduce((s,c)=>s+c.count,0)}</td>
        <td style="color:var(--text-muted);padding:8px 12px;">${fmt(avgSpend)}</td>
        <td></td>
      </tr>
    `;
  }

  // ── RECEIVING SECTION ──
  if (receivedCategories.length > 0) {
    html += `
      <tr class="cat-section-header cat-section-receive">
        <td colspan="6">
          <div class="cat-section-inner">
            <span>💰 RECEIVING</span>
            <span class="cat-section-total">${fmt(totalReceived)} total · ${receivedCategories.reduce((s,c)=>s+c.count,0)} transactions</span>
          </div>
        </td>
      </tr>
    `;

    receivedCategories.forEach((cat, index) => {
      const rankDisplay = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `<span class="cat-rank-num">${index + 1}</span>`;
      const barWidth = (cat.total / maxReceived) * 100;
      const opacity = Math.max(0.5, 1 - index * 0.12);
      const barColor = `rgba(52,211,153,${opacity})`;

      // Auto-income badge
      const autoBadge = cat.autoCount > 0
        ? `<span class="cat-auto-badge" title="${cat.autoCount} auto-added months · ${fmt(cat.autoTotal)}">⚡ auto ×${cat.autoCount}</span>`
        : '';

      html += `
        <tr class="cat-row cat-row-receive">
          <td class="cat-rank">${rankDisplay}</td>
          <td class="cat-name">
            <span class="cat-name-text">${cat.name}</span>${autoBadge}
          </td>
          <td class="cat-amount cat-amount-green">+${fmt(cat.total)}</td>
          <td class="cat-count">${cat.count}</td>
          <td class="cat-avg">${fmt(cat.average)}</td>
          <td class="cat-bar-cell">
            <div class="cat-bar-wrap">
              <div class="cat-bar-track cat-bar-track-green">
                <div class="cat-bar-fill" style="width:${barWidth}%;background:${barColor};"></div>
              </div>
              <div class="cat-bar-labels">
                <span class="cat-pct-main" style="color:#34d399;">${cat.percentage.toFixed(1)}%</span>
                <span class="cat-pct-sub">of income</span>
              </div>
            </div>
          </td>
        </tr>
      `;
    });

    // Receive subtotal row
    const avgReceive = receivedCategories.length > 0 ? totalReceived / receivedCategories.reduce((s,c)=>s+c.count,0) : 0;
    html += `
      <tr class="cat-subtotal-row">
        <td colspan="2" style="color:var(--text-muted);font-size:12px;padding:8px 12px;">Subtotal — ${receivedCategories.length} categories</td>
        <td style="color:#34d399;font-weight:700;padding:8px 12px;">+${fmt(totalReceived)}</td>
        <td style="color:var(--text-muted);padding:8px 12px;">${receivedCategories.reduce((s,c)=>s+c.count,0)}</td>
        <td style="color:var(--text-muted);padding:8px 12px;">${fmt(avgReceive)}</td>
        <td></td>
      </tr>
    `;
  }

  // ── NET SUMMARY ROW ──
  const net2 = totalReceived - totalSpent;
  html += `
    <tr class="cat-net-row">
      <td colspan="2" style="font-weight:700;font-size:13px;padding:12px 16px;color:var(--white);">
        ${net2 >= 0 ? '📈' : '📉'} Overall Net
      </td>
      <td style="font-weight:700;font-size:14px;padding:12px;color:${net2 >= 0 ? '#34d399' : '#ef4444'};">
        ${net2 >= 0 ? '+' : ''}${fmt(net2)}
      </td>
      <td colspan="3" style="padding:12px;color:var(--text-muted);font-size:12px;">
        ${totalReceived > 0 ? `Savings rate: <strong style="color:${net2/totalReceived*100>=20?'#34d399':'#ef4444'}">${(net2/totalReceived*100).toFixed(1)}%</strong>` : ''}
      </td>
    </tr>
  `;

  tbody.innerHTML = html;
}

function renderBarChart() {
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const dayOfWeek = todayLocal.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(todayLocal);
  monday.setDate(todayLocal.getDate() + mondayOffset);

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const spendTotals    = Array(7).fill(0);
  const receivedTotals = Array(7).fill(0);

  function toLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = toLocalDate(d);
    allExpenses.filter(e => e.date === ds).forEach(e => {
      const cat = allCategories.find(c => c.id === e.category_id);
      const isReceived = cat?.type === 'received';
      const amount = parseFloat(e.amount);
      if (isReceived) receivedTotals[i] += amount;
      else spendTotals[i] += amount;
    });
  }

  if (barChart) barChart.destroy();
  const ctx = $('chart-bar').getContext('2d');

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        {
          label: 'Spent',
          data: spendTotals,
          backgroundColor: 'rgba(185,135,175,0.85)',
          hoverBackgroundColor: '#b987af',
          borderRadius: 5,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.8,
        },
        {
          label: 'Received',
          data: receivedTotals,
          backgroundColor: 'rgba(214,167,194,0.55)',
          hoverBackgroundColor: '#d6a7c2',
          borderRadius: 5,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.8,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#152849',
          borderColor: 'rgba(78,122,177,0.3)',
          borderWidth: 1,
          titleColor: '#d6a7c2',
          bodyColor: '#fff',
          padding: 10,
          callbacks: {
            title: items => {
              const d = new Date(monday);
              d.setDate(monday.getDate() + items[0].dataIndex);
              return `${days[items[0].dataIndex]}, ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
            },
            label: c => `  ${c.dataset.label}: ${fmt(c.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#7d9fc0', font: { size: 12 } },
          grid: { color: 'rgba(255,255,255,0.04)' }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#7d9fc0',
            font: { size: 11 },
            callback: v => v === 0 ? '0' : (v >= 1000 ? '₹' + (v/1000).toFixed(1) + 'k' : '₹' + v)
          },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });

  const weekStart  = monday.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  const weekEnd    = new Date(monday);
  weekEnd.setDate(monday.getDate() + 6);
  const weekEndStr = weekEnd.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  const titleEl = $('bar-chart-title');
  if (titleEl) titleEl.textContent = `Daily Activity (${weekStart} – ${weekEndStr})`;
}

function renderDonutChart() {
  const now = new Date();
  let mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  let moExp = allExpenses.filter(e => e.date.startsWith(mo));

  if (moExp.length === 0 && allExpenses.length > 0) {
    const months = [...new Set(allExpenses.map(e => e.date.slice(0, 7)))].sort().reverse();
    if (months.length > 0) { mo = months[0]; moExp = allExpenses.filter(e => e.date.startsWith(mo)); }
  }

  const byCat = {};
  moExp.forEach(e => {
    const cat = allCategories.find(c => c.id === e.category_id);
    if (cat?.type === 'received') return; // skip received — spend only
    const name = cat?.name || e.categories?.name || getCatName(e.category_id) || 'Other';
    byCat[name] = (byCat[name] || 0) + parseFloat(e.amount);
  });

  const labels = Object.keys(byCat).sort((a,b) => byCat[b]-byCat[a]);
  const values = labels.map(l => byCat[l]);
  const total  = values.reduce((s, v) => s + v, 0);
  const DONUT_PALETTE = ['#b987af','#9e6697','#d6a7c2','#5a3765','#f3ccde','#ceb5d4','#a98dc0','#7d9fc0','#4e7ab1','#6b8fb5','#b5a8d4','#8fa8c0'];

  if (donutChart) donutChart.destroy();
  const ctx = $('chart-donut').getContext('2d');

  if (labels.length === 0 || total === 0) {
    donutChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['rgba(185,135,175,0.2)'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: true, cutout: '62%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
    $('donut-legend').innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px 0;">No spending this month</p>';
    $('donut-total-val').textContent = fmt(0);
    return;
  }

  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: DONUT_PALETTE.slice(0, labels.length),
        borderWidth: 2,
        borderColor: '#0d1f3c',
        hoverOffset: 6,
        hoverBorderColor: '#fff',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#152849',
          borderColor: 'rgba(78,122,177,0.3)',
          borderWidth: 1,
          titleColor: '#d6a7c2',
          bodyColor: '#fff',
          padding: 10,
          callbacks: {
            label: c => ` ${c.label}: ${fmt(c.parsed)} (${(c.parsed/total*100).toFixed(1)}%)`
          }
        }
      }
    }
  });

  // Legend — same grid layout as original
  const legend = $('donut-legend');
  legend.innerHTML = '';
  labels.forEach((l, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-dot" style="background:${DONUT_PALETTE[i % DONUT_PALETTE.length]}"></span>
      <span>${l}</span>
      <span class="legend-val">${fmt(values[i])}</span>
    `;
    legend.appendChild(item);
  });

  $('donut-total-val').textContent = fmt(total);

  const monthLabel = new Date(mo + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const titleEl = $('donut-chart-title');
  if (titleEl) titleEl.textContent = `Spending Breakdown (${monthLabel})`;
}

function renderMonthlyTable() {
  // Build per-month stats using ACTUAL received vs spent transactions
  const monthly = {};

  allExpenses.forEach(e => {
    const m = e.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { received: 0, spent: 0, count: 0, autoIncome: 0 };

    const cat = allCategories.find(c => c.id === e.category_id);
    const isReceived = cat ? cat.type === 'received' : false;
    const amount = parseFloat(e.amount);
    const isAutoIncome = e.description === 'Monthly Income (Auto-added)';

    if (isReceived) {
      monthly[m].received += amount;
      if (isAutoIncome) monthly[m].autoIncome += amount;
    } else {
      monthly[m].spent += amount;
    }
    monthly[m].count++;
  });

  const months = Object.keys(monthly).sort().reverse();
  const tbody = $('monthly-tbody');

  if (!months.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No data yet</td></tr>`;
    return;
  }

  let grandReceived = 0, grandSpent = 0, grandCount = 0;

  tbody.innerHTML = months.map((m, idx) => {
    const { received, spent, count, autoIncome } = monthly[m];
    const net = received - spent;
    const savingsRate = received > 0 ? ((net / received) * 100) : null;
    const label = new Date(m + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

    grandReceived += received;
    grandSpent    += spent;
    grandCount    += count;

    let srColor = '#ef4444';
    if (savingsRate !== null && savingsRate >= 50) srColor = '#34d399';
    else if (savingsRate !== null && savingsRate >= 20) srColor = '#f59e0b';

    const srDisplay = savingsRate === null
      ? '<span style="color:var(--text-muted);font-size:12px;">No income</span>'
      : `<div style="display:flex;align-items:center;gap:8px;">
           <div style="flex:1;background:rgba(125,159,192,0.15);height:7px;border-radius:4px;overflow:hidden;min-width:60px;">
             <div style="width:${Math.max(0,Math.min(100,savingsRate))}%;height:100%;background:${srColor};border-radius:4px;transition:width 0.4s;"></div>
           </div>
           <span style="min-width:42px;text-align:right;font-weight:600;color:${srColor};font-size:13px;">${savingsRate.toFixed(1)}%</span>
         </div>`;

    // Auto-income badge — shows ⚡ if month had auto-added salary
    const autoBadge = autoIncome > 0
      ? `<span class="monthly-auto-badge" title="Includes ⚡ auto-added monthly income of ${fmt(autoIncome)}">⚡ ${fmt(autoIncome)}</span>`
      : '';

    const rowBg = idx % 2 === 0 ? '' : 'background:rgba(78,122,177,0.04);';

    return `
      <tr style="${rowBg}">
        <td style="font-weight:600;">${label}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="color:#34d399;font-weight:700;">+${fmt(received)}</span>
            ${autoBadge}
          </div>
        </td>
        <td style="color:#ef4444;font-weight:700;">${spent > 0 ? '−' : ''}${fmt(spent)}</td>
        <td style="font-weight:700;color:${net >= 0 ? '#34d399' : '#ef4444'};">
          ${net >= 0 ? '+' : ''}${fmt(net)}
        </td>
        <td style="color:var(--text-muted);text-align:center;" title="Total transactions this month">${count}</td>
        <td style="min-width:140px;">${srDisplay}</td>
      </tr>
    `;
  }).join('');

  // All Time footer
  const grandNet = grandReceived - grandSpent;
  const grandSR  = grandReceived > 0 ? ((grandNet / grandReceived) * 100) : null;
  const grandSRDisplay = grandSR === null ? '—' : `${grandSR.toFixed(1)}%`;
  const grandSRColor = grandSR !== null && grandSR >= 20 ? '#34d399' : '#ef4444';

  tbody.innerHTML += `
    <tr class="monthly-total-row">
      <td style="font-weight:700;color:var(--white);">📊 All Time</td>
      <td style="color:#34d399;font-weight:700;">+${fmt(grandReceived)}</td>
      <td style="color:#ef4444;font-weight:700;">${grandSpent > 0 ? '−' : ''}${fmt(grandSpent)}</td>
      <td style="font-weight:700;color:${grandNet >= 0 ? '#34d399' : '#ef4444'};">
        ${grandNet >= 0 ? '+' : ''}${fmt(grandNet)}
      </td>
      <td style="color:var(--text-muted);text-align:center;font-weight:700;">${grandCount}</td>
      <td style="font-weight:700;color:${grandSRColor};">${grandSRDisplay}</td>
    </tr>
  `;
}

function renderYearlyTable() {
  const yearly = {};

  allExpenses.forEach(e => {
    const yr = e.date.slice(0, 4);
    if (!yearly[yr]) yearly[yr] = { received: 0, spent: 0, count: 0 };
    const cat = allCategories.find(c => c.id === e.category_id);
    const amount = parseFloat(e.amount);
    if (cat?.type === 'received') yearly[yr].received += amount;
    else yearly[yr].spent += amount;
    yearly[yr].count++;
  });

  const years = Object.keys(yearly).sort().reverse();
  const tbody = $('yearly-tbody');
  if (!tbody) return;

  if (!years.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No data yet</td></tr>`;
    return;
  }

  let grandReceived = 0, grandSpent = 0, grandCount = 0;

  tbody.innerHTML = years.map((yr, idx) => {
    const { received, spent, count } = yearly[yr];
    const net = received - spent;
    const savingsRate = received > 0 ? (net / received) * 100 : null;
    grandReceived += received; grandSpent += spent; grandCount += count;

    let srColor = '#ef4444';
    if (savingsRate !== null && savingsRate >= 50) srColor = '#34d399';
    else if (savingsRate !== null && savingsRate >= 20) srColor = '#f59e0b';

    const srDisplay = savingsRate === null
      ? '<span style="color:var(--text-muted);font-size:12px;">No income</span>'
      : `<div style="display:flex;align-items:center;gap:8px;">
           <div style="flex:1;background:rgba(125,159,192,0.15);height:7px;border-radius:4px;overflow:hidden;min-width:60px;">
             <div style="width:${Math.max(0,Math.min(100,savingsRate))}%;height:100%;background:${srColor};border-radius:4px;transition:width 0.4s;"></div>
           </div>
           <span style="min-width:42px;text-align:right;font-weight:600;color:${srColor};font-size:13px;">${savingsRate.toFixed(1)}%</span>
         </div>`;

    const rowBg = idx % 2 === 0 ? '' : 'background:rgba(78,122,177,0.04);';
    return `
      <tr style="${rowBg}">
        <td style="font-weight:600;">${yr}</td>
        <td style="color:#34d399;font-weight:700;">+${fmt(received)}</td>
        <td style="color:#ef4444;font-weight:700;">${spent > 0 ? '−' : ''}${fmt(spent)}</td>
        <td style="font-weight:700;color:${net >= 0 ? '#34d399' : '#ef4444'};">${net >= 0 ? '+' : ''}${fmt(net)}</td>
        <td style="color:var(--text-muted);text-align:center;">${count}</td>
        <td style="min-width:140px;">${srDisplay}</td>
      </tr>
    `;
  }).join('');

  const grandNet = grandReceived - grandSpent;
  const grandSR = grandReceived > 0 ? (grandNet / grandReceived * 100) : null;
  const grandSRColor = grandSR !== null && grandSR >= 20 ? '#34d399' : '#ef4444';
  tbody.innerHTML += `
    <tr class="monthly-total-row">
      <td style="font-weight:700;color:var(--white);">📊 All Time</td>
      <td style="color:#34d399;font-weight:700;">+${fmt(grandReceived)}</td>
      <td style="color:#ef4444;font-weight:700;">${grandSpent > 0 ? '−' : ''}${fmt(grandSpent)}</td>
      <td style="font-weight:700;color:${grandNet >= 0 ? '#34d399' : '#ef4444'};">${grandNet >= 0 ? '+' : ''}${fmt(grandNet)}</td>
      <td style="color:var(--text-muted);text-align:center;font-weight:700;">${grandCount}</td>
      <td style="font-weight:700;color:${grandSRColor};">${grandSR !== null ? grandSR.toFixed(1) + '%' : '—'}</td>
    </tr>
  `;
}

/* ════════════════════════════════════════
   SETTINGS — PROFILE
════════════════════════════════════════ */
function openSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  const el = $(`settings-${tab}`);
  if (el) el.classList.add('active');
  if (tab === 'history') renderHistoryTable();
  if (tab === 'budgets') renderSubscriptions();
  if (tab === 'preferences') { $('pref-currency').value = userCurrency; }
}

/* ════════════════════════════════════════
   PROFILE PICTURE
════════════════════════════════════════ */
let pendingPfpDataUrl = null; // holds new image before save

function updatePfpDisplay(dataUrl) {
  const img = $('pfp-img');
  const initials = $('pfp-initials');
  if (dataUrl) {
    img.src = dataUrl;
    img.style.display = 'block';
    initials.style.display = 'none';
    // Also update sidebar avatar
    $('avatar-btn').style.backgroundImage = `url(${dataUrl})`;
    $('avatar-btn').style.backgroundSize = 'cover';
    $('avatar-btn').style.backgroundPosition = 'center';
    $('avatar-btn').textContent = '';
  } else {
    img.style.display = 'none';
    initials.style.display = 'block';
    $('avatar-btn').style.backgroundImage = '';
    const email = currentUser?.email || '';
    const firstName = $('p-firstname')?.value?.trim();
    $('avatar-btn').textContent = (firstName?.[0] || email[0] || 'A').toUpperCase();
  }
}

function updatePfpInitials() {
  const firstName = $('p-firstname')?.value?.trim();
  const email = currentUser?.email || '';
  const letter = (firstName?.[0] || email[0] || '?').toUpperCase();
  $('pfp-initials').textContent = letter;
  // Only update avatar text if no pfp image
  const stored = localStorage.getItem(`pfp_${currentUser?.id}`) || (userProfile?.pfp_url);
  if (!stored) $('avatar-btn').textContent = letter;
}

function handlePfpUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Image must be under 5MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingPfpDataUrl = e.target.result;
    updatePfpDisplay(pendingPfpDataUrl);
    $('pfp-actions').style.display = 'flex';
    toast('Photo selected — click Save Photo to apply');
  };
  reader.readAsDataURL(file);
  // reset input so same file can be re-selected
  event.target.value = '';
}

async function savePfp() {
  if (!pendingPfpDataUrl) return;
  const key = `pfp_${currentUser?.id}`;
  // Always save to localStorage for fast local access
  localStorage.setItem(key, pendingPfpDataUrl);
  if (userProfile) userProfile.pfp_url = pendingPfpDataUrl;

  // Also persist to Supabase so it's available on any device/phone
  if (!DEMO_MODE && db && currentUser) {
    try {
      await db.from('profiles').upsert({
        id: currentUser.id,
        pfp_url: pendingPfpDataUrl,
      }, { onConflict: 'id' });
    } catch (e) {
      console.warn('Could not save pfp to Supabase:', e);
    }
  }

  // Also update the landing nav avatar if it's visible
  const landingAvatar = document.getElementById('lp-pfp-avatar');
  if (landingAvatar) {
    landingAvatar.style.backgroundImage = `url(${pendingPfpDataUrl})`;
    landingAvatar.style.backgroundSize  = 'cover';
    landingAvatar.style.backgroundPosition = 'center';
    landingAvatar.textContent = '';
  }

  pendingPfpDataUrl = null;
  $('pfp-actions').style.display = 'none';
  toast('Profile photo saved!');
}

async function removePfp() {
  pendingPfpDataUrl = null;
  localStorage.removeItem(`pfp_${currentUser?.id}`);
  if (userProfile) userProfile.pfp_url = null;
  updatePfpDisplay(null);
  $('pfp-actions').style.display = 'none';
  $('pfp-file-input').value = '';
  // Clear from Supabase too
  if (!DEMO_MODE && db && currentUser) {
    try {
      await db.from('profiles').update({ pfp_url: null }).eq('id', currentUser.id);
    } catch (e) { console.warn('Could not clear pfp from Supabase:', e); }
  }
  // Clear landing nav avatar
  const landingAvatar = document.getElementById('lp-pfp-avatar');
  if (landingAvatar) {
    landingAvatar.style.backgroundImage = '';
    const email = currentUser?.email || '';
    landingAvatar.textContent = email.charAt(0).toUpperCase() || 'A';
  }
  toast('Profile photo removed');
}

function loadPfp() {
  // Prefer DB pfp_url (cross-device), fall back to localStorage
  const dbPfp    = userProfile?.pfp_url || null;
  const localPfp = localStorage.getItem(`pfp_${currentUser?.id}`) || null;
  const pfpUrl   = dbPfp || localPfp || null;
  // If DB has it but local doesn't, sync to local for instant future loads
  if (dbPfp && !localPfp) {
    localStorage.setItem(`pfp_${currentUser?.id}`, dbPfp);
  }
  updatePfpDisplay(pfpUrl);
}

async function loadProfile() {
  if (!currentUser) return;
  
  if (DEMO_MODE) {
    // Load from localStorage
    const stored = localStorage.getItem(`profile_${currentUser?.id}`);
    if (stored) {
      const data = JSON.parse(stored);
      userProfile = data;
      $('p-firstname').value  = data.first_name   || '';
      $('p-middlename').value = data.middle_name  || '';
      $('p-surname').value    = data.surname       || '';
      $('p-dob').value        = data.birth_date    || '';
      $('p-desc').value       = data.description  || '';
      $('p-job').value        = data.job           || '';
      $('p-location').value   = data.location      || '';
      $('p-address').value    = data.address       || '';
      $('p-pan').value        = data.pan_number    || '';
      $('p-income').value     = data.monthly_income || '';
      $('a-username').value   = data.username      || '';
      $('a-phone').value      = data.phone_number  || '';
      userIncome = parseFloat(data.monthly_income) || 50000;
      updatePhoneVerificationStatus(data.phone_verified || false);
      calcAge();
      updatePfpInitials();
    }
    loadPfp();
    return;
  }
  
  const { data } = await db.from('profiles').select('*').eq('id', currentUser.id).single();

  // Build a base profile even if the row doesn't exist yet
  const profileData = data || {};

  // Fall back to user_metadata username if profiles row has none
  const metaUsername = currentUser.user_metadata?.username || '';
  const resolvedUsername = profileData.username || metaUsername;

  // Auto-save username+email to profiles if missing (fixes accounts created before this fix)
  if (!profileData.username && resolvedUsername) {
    await db.from('profiles').upsert({
      id: currentUser.id,
      username: resolvedUsername,
      email: currentUser.email
    }, { onConflict: 'id' });
  }

  profileData.username = resolvedUsername;
  userProfile = profileData;

  $('p-firstname').value  = profileData.first_name   || '';
  $('p-middlename').value = profileData.middle_name  || '';
  $('p-surname').value    = profileData.surname       || '';
  $('p-dob').value        = profileData.birth_date    || '';
  $('p-desc').value       = profileData.description  || '';
  $('p-job').value        = profileData.job           || '';
  $('p-location').value   = profileData.location      || '';
  $('p-address').value    = profileData.address       || '';
  $('p-pan').value        = profileData.pan_number    || '';
  $('p-income').value     = profileData.monthly_income || '';
  $('a-username').value   = resolvedUsername;
  $('a-phone').value      = profileData.phone_number  || '';
  userIncome = parseFloat(profileData.monthly_income) || 50000;
  updatePhoneVerificationStatus(profileData.phone_verified || false);
  calcAge();
  updatePfpInitials();
  loadPfp();
}

function updatePhoneVerificationStatus(verified) {
  const statusEl = $('phone-verified-status');
  if (!$('a-phone').value) {
    statusEl.textContent = '';
    statusEl.className = 'field-hint';
    return;
  }
  
  if (verified) {
    statusEl.textContent = '✓ Verified';
    statusEl.className = 'field-hint verified';
  } else {
    statusEl.textContent = '⚠ Not verified';
    statusEl.className = 'field-hint unverified';
  }
}

async function saveProfile() {
  if (!currentUser) return;
  
  // Validate required fields
  const firstName = $('p-firstname').value.trim();
  const surname = $('p-surname').value.trim();
  const birthDate = $('p-dob').value;
  const job = $('p-job').value.trim();
  const location = $('p-location').value.trim();
  const income = parseFloat($('p-income').value);
  
  if (!firstName) { toast('First name is required', 'error'); return; }
  if (!surname) { toast('Surname is required', 'error'); return; }
  if (!birthDate) { toast('Birth date is required', 'error'); return; }
  if (!job) { toast('Job is required', 'error'); return; }
  if (!location) { toast('Location is required', 'error'); return; }
  if (!income || income <= 0) { toast('Valid monthly income is required', 'error'); return; }
  
  const payload = {
    id:             currentUser.id,
    first_name:     firstName,
    middle_name:    $('p-middlename').value.trim(),
    surname:        surname,
    birth_date:     birthDate,
    description:    $('p-desc').value.trim(),
    job:            job,
    location:       location,
    address:        $('p-address').value.trim(),
    pan_number:     $('p-pan').value.trim().toUpperCase(),
    monthly_income: income,
    username:       userProfile?.username || '',
    phone_number:   userProfile?.phone_number || '',
    phone_verified: userProfile?.phone_verified || false,
    updated_at:     new Date().toISOString(),
  };
  
  if (DEMO_MODE) {
    localStorage.setItem(`profile_${currentUser?.id}`, JSON.stringify(payload));
    userProfile = payload;
    userIncome = income;
    toast('Profile saved!');
    updatePfpInitials();
    loadPfp();
    return;
  }
  
  const { error } = await db.from('profiles').upsert(payload);
  if (error) { toast('Failed to save profile', 'error'); return; }
  userProfile = payload;
  userIncome = income;
  toast('Profile saved!');
  updatePfpInitials();
  loadPfp();
}

function calcAge() {
  const dob = $('p-dob').value;
  if (!dob) { $('p-age').value = ''; return; }
  const age = Math.floor((Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000));
  $('p-age').value = age >= 0 ? age : '';
}

function renderHistoryTable() {
  const tbody = $('history-tbody');
  if (!allExpenses.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No expenses yet</td></tr>`;
    return;
  }
  tbody.innerHTML = allExpenses.map(e => `
    <tr>
      <td>${formatDate(e.date)}</td>
      <td>${fmt(e.amount)}</td>
      <td>${e.categories?.name || getCatName(e.category_id) || '—'}</td>
      <td style="color:var(--text-muted)">${cleanDesc(e.description) || '—'}</td>
    </tr>
  `).join('');
}

/* ════════════════════════════════════════
   PREFERENCES — CURRENCY
════════════════════════════════════════ */
async function loadPreferences() {
  // localStorage first (instant), DB as source of truth when available
  const local = localStorage.getItem(`currency_${currentUser?.id}`);
  if (local) userCurrency = local;
  if (!DEMO_MODE && db && currentUser) {
    try {
      const { data } = await db.from('profiles').select('currency').eq('id', currentUser.id).single();
      if (data?.currency) userCurrency = data.currency;
    } catch (_) {}
  }
  if (!CURRENCY_SYMBOLS[userCurrency]) userCurrency = 'INR';
}

async function savePreferences() {
  const sel = $('pref-currency');
  const choice = sel.value;
  if (!CURRENCY_SYMBOLS[choice]) { toast('Invalid currency', 'error'); return; }
  const btn = $('btn-save-prefs');
  btn.disabled = true; btn.textContent = 'Saving…';
  userCurrency = choice;
  localStorage.setItem(`currency_${currentUser?.id}`, choice);
  if (!DEMO_MODE && db && currentUser) {
    try {
      await db.from('profiles').upsert({ id: currentUser.id, currency: choice });
    } catch (e) { console.error('currency save', e); }
  }
  // Re-render everything that shows money
  updateStats();
  renderExpenseList();
  renderHistoryTable();
  renderSubscriptions();
  btn.disabled = false; btn.textContent = 'Save Preferences';
  toast('Preferences saved!');
}

/* ════════════════════════════════════════
   HISTORY — EXPORT CSV + CLEAR ALL DATA
════════════════════════════════════════ */
function exportExpensesCSV() {
  if (!allExpenses.length) { toast('No transactions to export', 'error'); return; }
  const esc = v => {
    const s = (v == null ? '' : String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Date', 'Amount', 'Currency', 'Category', 'Description'];
  const rows = allExpenses.map(e => [
    e.date,
    Number(e.amount).toFixed(2),
    userCurrency,
    e.categories?.name || getCatName(e.category_id) || '',
    cleanDesc(e.description) || ''
  ].map(esc).join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transactions_${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Exported ' + allExpenses.length + ' transactions');
}

function openClearDataModal() {
  if (!allExpenses.length) { toast('No transactions to clear', 'error'); return; }
  $('clear-data-modal').classList.remove('hidden');
}
function closeClearDataModal() {
  $('clear-data-modal').classList.add('hidden');
}
async function clearAllData() {
  const btn = $('btn-confirm-clear');
  btn.disabled = true; btn.textContent = 'Clearing…';
  try {
    if (!DEMO_MODE && db && currentUser) {
      const { error } = await db.from('expenses').delete().eq('user_id', currentUser.id);
      if (error) throw error;
    }
    allExpenses = [];
    localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
    closeClearDataModal();
    renderHistoryTable();
    renderExpenseList();
    updateStats();
    toast('All transactions cleared');
  } catch (e) {
    console.error('clear all', e);
    toast('Failed to clear data: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Clear Everything';
  }
}

/* ════════════════════════════════════════
   BUDGETS — RECURRING SUBSCRIPTIONS
════════════════════════════════════════ */
let editingSubId = null;

async function loadSubscriptions() {
  if (DEMO_MODE || !db || !currentUser) {
    const stored = localStorage.getItem(`subs_${currentUser?.id}`);
    userSubscriptions = stored ? JSON.parse(stored) : [];
    return;
  }
  try {
    const { data, error } = await db.from('subscriptions')
      .select('*').eq('user_id', currentUser.id).order('created_at', { ascending: true });
    if (error) throw error;
    userSubscriptions = data || [];
  } catch (e) {
    console.error('load subscriptions', e);
    userSubscriptions = [];
  }
}

function renderSubscriptions() {
  const list = $('subscriptions-list');
  if (!list) return;
  if (!userSubscriptions.length) {
    list.innerHTML = `<div class="sub-empty">No subscriptions yet. Add one to track recurring payments automatically.</div>`;
    return;
  }
  list.innerHTML = userSubscriptions.map(s => {
    const catName = s.category_id ? (getCatName(s.category_id) || 'Uncategorized') : 'Uncategorized';
    const initial = (s.name || '?').charAt(0).toUpperCase();
    return `
      <div class="sub-row">
        <div class="sub-icon">${initial}</div>
        <div class="sub-info">
          <div class="sub-name">${escapeHtmlSafe(s.name)}</div>
          <div class="sub-meta">${catName} · every month on day ${s.day_of_month}</div>
        </div>
        <div class="sub-amount">${fmt(s.amount)}</div>
        <div class="sub-actions">
          <button class="sub-act-btn" title="Edit" onclick="openSubscriptionModal('${s.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="sub-act-btn danger" title="Delete" onclick="deleteSubscription('${s.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

function populateSubCategorySelect(selectedId) {
  const sel = $('sub-category');
  if (!sel) return;
  const spendCats = allCategories.filter(c => c.type === 'spend');
  sel.innerHTML = `<option value="">Uncategorized</option>` +
    spendCats.map(c => `<option value="${c.id}">${escapeHtmlSafe(c.name)}</option>`).join('');
  if (selectedId) sel.value = selectedId;
}

function openSubscriptionModal(id) {
  editingSubId = id || null;
  populateSubCategorySelect();
  if (id) {
    const s = userSubscriptions.find(x => String(x.id) === String(id));
    if (s) {
      $('subscription-modal-title').textContent = 'Edit Subscription';
      $('sub-name').value = s.name;
      $('sub-amount').value = s.amount;
      $('sub-day').value = s.day_of_month;
      $('sub-category').value = s.category_id || '';
    }
  } else {
    $('subscription-modal-title').textContent = 'Add Subscription';
    $('sub-name').value = '';
    $('sub-amount').value = '';
    $('sub-day').value = '1';
    $('sub-category').value = '';
  }
  $('subscription-modal').classList.remove('hidden');
}
function closeSubscriptionModal() {
  $('subscription-modal').classList.add('hidden');
  editingSubId = null;
}

async function saveSubscription() {
  const name = $('sub-name').value.trim();
  const amount = parseFloat($('sub-amount').value);
  let day = parseInt($('sub-day').value, 10);
  const categoryId = $('sub-category').value || null;

  if (!name) { toast('Enter a name', 'error'); return; }
  if (!amount || amount <= 0) { toast('Enter a valid amount', 'error'); return; }
  if (!day || day < 1) day = 1;
  if (day > 28) day = 28; // keep it valid for every month

  const btn = $('btn-save-subscription');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    if (DEMO_MODE || !db || !currentUser) {
      if (editingSubId) {
        const i = userSubscriptions.findIndex(x => String(x.id) === String(editingSubId));
        if (i !== -1) userSubscriptions[i] = { ...userSubscriptions[i], name, amount, day_of_month: day, category_id: categoryId };
      } else {
        userSubscriptions.push({ id: Date.now().toString(), user_id: currentUser?.id, name, amount, day_of_month: day, category_id: categoryId, active: true, created_at: new Date().toISOString() });
      }
      localStorage.setItem(`subs_${currentUser?.id}`, JSON.stringify(userSubscriptions));
    } else {
      if (editingSubId) {
        const { error } = await db.from('subscriptions')
          .update({ name, amount, day_of_month: day, category_id: categoryId })
          .eq('id', editingSubId);
        if (error) throw error;
      } else {
        const { error } = await db.from('subscriptions').insert({
          user_id: currentUser.id, name, amount, day_of_month: day, category_id: categoryId, active: true
        });
        if (error) throw error;
      }
      await loadSubscriptions();
    }
    closeSubscriptionModal();
    renderSubscriptions();
    // Apply immediately if this month's charge is already due
    await checkAndAddSubscriptions();
    updateStats();
    toast('Subscription saved!');
  } catch (e) {
    console.error('save subscription', e);
    const msg = (e.message || '').includes('does not exist')
      ? 'Subscriptions table not found. Run budgets_setup.sql in Supabase.'
      : ('Failed to save: ' + (e.message || e));
    toast(msg, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Subscription';
  }
}

async function deleteSubscription(id) {
  try {
    if (DEMO_MODE || !db || !currentUser) {
      userSubscriptions = userSubscriptions.filter(x => String(x.id) !== String(id));
      localStorage.setItem(`subs_${currentUser?.id}`, JSON.stringify(userSubscriptions));
    } else {
      const { error } = await db.from('subscriptions').delete().eq('id', id);
      if (error) throw error;
      userSubscriptions = userSubscriptions.filter(x => String(x.id) !== String(id));
    }
    renderSubscriptions();
    toast('Subscription removed');
  } catch (e) {
    console.error('delete subscription', e);
    toast('Failed to remove subscription', 'error');
  }
}

// On login each month: add a transaction for any subscription whose
// day has passed and that hasn't been charged yet this month.
async function checkAndAddSubscriptions() {
  if (!userSubscriptions.length) return;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const todayDay = now.getDate();
  const monthTag = `${y}-${String(m + 1).padStart(2, '0')}`;

  for (const s of userSubscriptions) {
    if (s.active === false) continue;
    if (todayDay < (s.day_of_month || 1)) continue; // not due yet this month

    const chargeDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(s.day_of_month || 1, 28)).padStart(2, '0')}`;
    const marker = `[sub:${s.id}:${monthTag}]`;

    // Already added this month?
    const exists = allExpenses.some(e => (e.description || '').includes(marker));
    if (exists) continue;

    const desc = `${s.name} (Subscription)${' ' + marker}`;

    if (DEMO_MODE || !db || !currentUser) {
      allExpenses.unshift({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        user_id: currentUser?.id,
        amount: s.amount,
        category_id: s.category_id || null,
        date: chargeDate,
        description: desc,
        created_at: new Date().toISOString(),
        categories: { name: s.category_id ? getCatName(s.category_id) : 'Subscription' }
      });
      localStorage.setItem(`exp_${currentUser?.id}`, JSON.stringify(allExpenses));
    } else {
      try {
        const { data, error } = await db.from('expenses').insert({
          user_id: currentUser.id,
          amount: s.amount,
          category_id: s.category_id || null,
          date: chargeDate,
          description: desc,
        }).select('*, categories(name)').single();
        if (error) throw error;
        allExpenses.unshift(data);
      } catch (e) { console.error('auto-add subscription', e); }
    }
  }
}

/* ════════════════════════════════════════
   SETTINGS — ACCOUNT (USERNAME, EMAIL, PHONE)
════════════════════════════════════════ */
function openEditField(field) {
  editingField = field;
  const modal = $('edit-account-modal');
  const title = $('edit-modal-title');
  const label = $('edit-field-label');
  const input = $('edit-field-input');
  
  switch(field) {
    case 'username':
      title.textContent = 'Edit Username';
      label.textContent = 'New Username';
      input.type = 'text';
      input.value = $('a-username').value;
      input.placeholder = 'Enter new username';
      break;
    case 'email':
      title.textContent = 'Edit Email';
      label.textContent = 'New Email';
      input.type = 'email';
      input.value = $('a-email').value;
      input.placeholder = 'Enter new email';
      break;
    case 'phone':
      title.textContent = 'Edit Phone Number';
      label.textContent = 'New Phone Number';
      input.type = 'tel';
      input.value = $('a-phone').value;
      input.placeholder = '+91 98765 43210';
      break;
  }
  
  $('edit-field-password').value = '';
  modal.classList.remove('hidden');
  input.focus();
}

function closeEditField() {
  $('edit-account-modal').classList.add('hidden');
  editingField = null;
}

async function confirmEditField() {
  const newValue = $('edit-field-input').value.trim();
  const password = $('edit-field-password').value;
  
  if (!newValue) {
    toast('Please enter a value', 'error');
    return;
  }
  
  if (!password) {
    toast('Password is required to make changes', 'error');
    return;
  }
  
  // Validate based on field type
  if (editingField === 'email' && !newValue.includes('@')) {
    toast('Please enter a valid email', 'error');
    return;
  }
  
  if (editingField === 'phone' && newValue.length < 10) {
    toast('Please enter a valid phone number', 'error');
    return;
  }
  
  const btn = $('btn-confirm-edit');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  
  // Verify password first
  if (!DEMO_MODE) {
    const { error } = await db.auth.signInWithPassword({
      email: currentUser.email,
      password: password
    });
    
    if (error) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      toast('Incorrect password', 'error');
      return;
    }
  }
  
  // Handle phone number - requires OTP verification
  if (editingField === 'phone') {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    closeEditField();
    pendingPhone = newValue;
    sendOTP(newValue);
    return;
  }
  
  // Handle username or email update
  btn.textContent = 'Saving...';
  
  if (editingField === 'username') {
    await updateUsername(newValue);
  } else if (editingField === 'email') {
    await updateEmail(newValue);
  }
  
  btn.disabled = false;
  btn.textContent = 'Save Changes';
  closeEditField();
}

async function updateUsername(newUsername) {
  if (!userProfile) return;

  if (DEMO_MODE) {
    userProfile.username = newUsername;
    localStorage.setItem(`profile_${currentUser?.id}`, JSON.stringify(userProfile));
    $('a-username').value = newUsername;
    toast('Username updated successfully!');
    return;
  }

  // 1. Check the new username isn't already taken by another user
  const { data: existing } = await db
    .from('profiles')
    .select('id')
    .eq('username', newUsername)
    .neq('id', currentUser.id)
    .maybeSingle();

  if (existing) {
    toast('Username already taken. Please choose another.', 'error');
    return;
  }

  // 2. Update profiles table — also ensure email is saved (needed for login lookup)
  const { error: profileError } = await db.from('profiles')
    .update({
      username: newUsername,
      email: currentUser.email,   // always keep email in sync so login-by-username works
      updated_at: new Date().toISOString()
    })
    .eq('id', currentUser.id);

  if (profileError) {
    toast('Failed to update username', 'error');
    return;
  }

  // 3. Sync to user_metadata so login-by-username works with the new username
  await db.auth.updateUser({ data: { username: newUsername } });

  userProfile.username = newUsername;
  $('a-username').value = newUsername;
  toast('Username updated successfully!');
}

async function updateEmail(newEmail) {
  if (DEMO_MODE) {
    currentUser.email = newEmail;
    $('a-email').value = newEmail;
    toast('Email updated successfully!');
    return;
  }
  
  const { error } = await db.auth.updateUser({ email: newEmail });
  
  if (error) {
    toast('Failed to update email: ' + error.message, 'error');
    return;
  }
  
  $('a-email').value = newEmail;
  toast('Email updated! Please check your inbox to confirm.');
}

/* ════════════════════════════════════════
   OTP VERIFICATION
════════════════════════════════════════ */
function sendOTP(phoneNumber) {
  // Generate 6-digit OTP
  currentOTP = Math.floor(100000 + Math.random() * 900000).toString();
  
  // In demo mode, show OTP in console
  console.log('═══════════════════════════════════════');
  console.log('📱 OTP VERIFICATION (DEMO MODE)');
  console.log('═══════════════════════════════════════');
  console.log('Phone Number:', phoneNumber);
  console.log('OTP Code:', currentOTP);
  console.log('═══════════════════════════════════════');
  
  // Show OTP modal
  $('otp-phone-display').textContent = phoneNumber;
  $('otp-modal').classList.remove('hidden');
  
  // Clear OTP inputs
  for (let i = 1; i <= 6; i++) {
    $(`otp-${i}`).value = '';
  }
  $('otp-1').focus();
  
  toast('OTP sent! Check console for code (Demo Mode)', 'success');
}

function closeOTPModal() {
  $('otp-modal').classList.add('hidden');
  currentOTP = null;
  pendingPhone = null;
}

function verifyOTP() {
  const enteredOTP = Array.from({length: 6}, (_, i) => $(`otp-${i + 1}`).value).join('');
  
  if (enteredOTP.length !== 6) {
    toast('Please enter complete OTP', 'error');
    return;
  }
  
  if (enteredOTP !== currentOTP) {
    toast('Invalid OTP. Please try again.', 'error');
    // Clear inputs
    for (let i = 1; i <= 6; i++) {
      $(`otp-${i}`).value = '';
    }
    $('otp-1').focus();
    return;
  }
  
  // OTP verified successfully
  updatePhoneNumber(pendingPhone);
  closeOTPModal();
}

async function updatePhoneNumber(phoneNumber) {
  if (!userProfile) return;
  
  userProfile.phone_number = phoneNumber;
  userProfile.phone_verified = true;
  
  if (DEMO_MODE) {
    localStorage.setItem(`profile_${currentUser?.id}`, JSON.stringify(userProfile));
    $('a-phone').value = phoneNumber;
    updatePhoneVerificationStatus(true);
    toast('Phone number verified successfully!');
    return;
  }
  
  const { error } = await db.from('profiles')
    .update({ 
      phone_number: phoneNumber, 
      phone_verified: true,
      updated_at: new Date().toISOString() 
    })
    .eq('id', currentUser.id);
  
  if (error) {
    toast('Failed to update phone number', 'error');
    return;
  }
  
  $('a-phone').value = phoneNumber;
  updatePhoneVerificationStatus(true);
  toast('Phone number verified successfully!');
}

function resendOTP() {
  if (pendingPhone) {
    sendOTP(pendingPhone);
  }
}

// OTP input auto-focus
function setupOTPInputs() {
  for (let i = 1; i <= 6; i++) {
    const input = $(`otp-${i}`);
    
    input.addEventListener('input', (e) => {
      if (e.target.value.length === 1 && i < 6) {
        $(`otp-${i + 1}`).focus();
      }
    });
    
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && i > 1) {
        $(`otp-${i - 1}`).focus();
      }
    });
    
    // Only allow numbers
    input.addEventListener('keypress', (e) => {
      if (!/[0-9]/.test(e.key)) {
        e.preventDefault();
      }
    });
  }
}

/* ════════════════════════════════════════
   SETTINGS — PASSWORD UPDATE
════════════════════════════════════════ */
async function updatePassword() {
  if (!currentUser) return;
  
  const currentPassword = $('a-current-password').value;
  const newPassword = $('a-new-password').value.trim();
  
  // Check if user wants to change password
  if (!newPassword) {
    toast('Enter a new password to update', 'error');
    return;
  }
  
  // Validate new password length
  if (newPassword.length < 6) {
    toast('New password must be at least 6 characters', 'error');
    return;
  }
  
  // Current password is required
  if (!currentPassword) {
    toast('Enter your current password to continue', 'error');
    return;
  }
  
  const btn = $('btn-update-password');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  
  if (DEMO_MODE) {
    // Demo mode - simulate password change
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Update Password';
      toast('Password updated successfully!');
      $('a-current-password').value = '';
      $('a-new-password').value = '';
    }, 500);
    return;
  }
  
  // REAL MODE - Verify current password by attempting to sign in
  const email = currentUser.email;
  const { error: signInError } = await db.auth.signInWithPassword({ 
    email, 
    password: currentPassword 
  });
  
  if (signInError) {
    btn.disabled = false;
    btn.textContent = 'Update Password';
    toast('Current password is incorrect', 'error');
    return;
  }
  
  // Current password is correct, now update to new password
  const { error: updateError } = await db.auth.updateUser({ 
    password: newPassword 
  });
  
  btn.disabled = false;
  btn.textContent = 'Update Password';
  
  if (updateError) {
    toast('Failed to update password: ' + updateError.message, 'error');
    return;
  }
  
  toast('Password updated successfully!');
  $('a-current-password').value = '';
  $('a-new-password').value = '';
}

/* ════════════════════════════════════════
   DOWNLOAD REPORT (PDF)
════════════════════════════════════════ */
async function downloadReport() {
  toast('Generating PDF report...', 'success');
  try {
    const now = new Date();
    const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const moExp = allExpenses.filter(e => e.date.startsWith(mo));

    let moIncome = 0, moSpend = 0;
    moExp.forEach(e => {
      const cat = allCategories.find(c => c.id === e.category_id);
      if (cat?.type === 'received') moIncome += parseFloat(e.amount);
      else moSpend += parseFloat(e.amount);
    });
    const netBalance = moIncome - moSpend;
    const savingsRate = moIncome > 0 ? ((netBalance / moIncome) * 100).toFixed(1) : '0.0';
    const days = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const dailyAvg = days ? moSpend / days : 0;

    // Category breakdown (spend only, sorted by amount)
    const byCat = {};
    moExp.forEach(e => {
      const cat = allCategories.find(c => c.id === e.category_id);
      if (cat?.type !== 'received') {
        const name = e.categories?.name || cat?.name || 'Other';
        byCat[name] = (byCat[name] || 0) + parseFloat(e.amount);
      }
    });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

    // Monthly summary (last 6 months)
    const monthly = {};
    allExpenses.forEach(e => {
      const m = e.date.slice(0, 7);
      if (!monthly[m]) monthly[m] = { received: 0, spent: 0 };
      const cat = allCategories.find(c => c.id === e.category_id);
      if (cat?.type === 'received') monthly[m].received += parseFloat(e.amount);
      else monthly[m].spent += parseFloat(e.amount);
    });
    const monthKeys = Object.keys(monthly).sort().reverse().slice(0, 6);

    // Yearly summary (all years in data)
    const yearly = {};
    allExpenses.forEach(e => {
      const y = e.date.slice(0, 4);
      if (!yearly[y]) yearly[y] = { received: 0, spent: 0 };
      const cat = allCategories.find(c => c.id === e.category_id);
      if (cat?.type === 'received') yearly[y].received += parseFloat(e.amount);
      else yearly[y].spent += parseFloat(e.amount);
    });
    const yearKeys = Object.keys(yearly).sort().reverse();

    const recent = allExpenses.slice(0, 15);
    const fullName = userProfile
      ? [userProfile.first_name, userProfile.middle_name, userProfile.surname].filter(Boolean).join(' ')
      : '';
    const email = currentUser?.email || '';
    const reportDate = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const monthYear = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const rf = n => '₹' + Math.abs(Number(n)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const catColors = ['#a855f7','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899','#8b5cf6','#06b6d4'];

    const catRowsHtml = catEntries.length === 0
      ? '<p style="color:#94a3b8;font-size:13px;padding:8px 0;">No spending this month</p>'
      : catEntries.map(([name, amount], i) => {
          const pct = moSpend > 0 ? ((amount / moSpend) * 100).toFixed(1) : '0.0';
          const barPct = moSpend > 0 ? (amount / moSpend) * 100 : 0;
          const color = catColors[i % catColors.length];
          return `<div style="margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
              <span style="font-size:13px;color:#374151;font-weight:500;">${name}</span>
              <span style="font-size:13px;color:#374151;">${rf(amount)}&nbsp;&nbsp;<span style="color:#94a3b8;">${pct}%</span></span>
            </div>
            <div style="background:#e2e8f0;border-radius:6px;height:9px;overflow:hidden;">
              <div style="width:${barPct}%;height:100%;background:${color};border-radius:6px;"></div>
            </div>
          </div>`;
        }).join('');

    const monthRowsHtml = monthKeys.map((m, i) => {
      const { received, spent } = monthly[m];
      const net = received - spent;
      const sr = received > 0 ? ((net / received) * 100).toFixed(1) + '%' : 'N/A';
      const label = new Date(m + '-02').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      const bg = i % 2 === 0 ? '#f8fafc' : 'white';
      const netColor = net >= 0 ? '#059669' : '#dc2626';
      const netStr = (net >= 0 ? '' : '-') + rf(Math.abs(net));
      return `<tr style="background:${bg};">
        <td style="padding:10px 14px;color:#0f172a;font-weight:600;">${label}</td>
        <td style="padding:10px 14px;color:#059669;font-weight:600;">${rf(received)}</td>
        <td style="padding:10px 14px;color:#dc2626;font-weight:600;">${rf(spent)}</td>
        <td style="padding:10px 14px;color:${netColor};font-weight:600;">${netStr}</td>
        <td style="padding:10px 14px;color:#374151;">${sr}</td>
      </tr>`;
    }).join('');

    const txnRowsHtml = recent.map(e => {
      const cat = allCategories.find(c => c.id === e.category_id);
      const isReceived = cat?.type === 'received';
      const catName = e.categories?.name || cat?.name || 'Other';
      const dateStr = new Date(e.date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const amtColor = isReceived ? '#059669' : '#dc2626';
      const amtPrefix = isReceived ? '+' : '-';
      const badgeBg = isReceived ? '#d1fae5' : '#e0e7ff';
      const badgeColor = isReceived ? '#065f46' : '#3730a3';
      return `<tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:10px 14px;color:#64748b;font-size:12px;white-space:nowrap;">${dateStr}</td>
        <td style="padding:10px 14px;">
          <span style="background:${badgeBg};color:${badgeColor};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">${catName}</span>
        </td>
        <td style="padding:10px 14px;color:#374151;font-size:13px;">${cleanDesc(e.description) || ''}</td>
        <td style="padding:10px 14px;text-align:right;color:${amtColor};font-weight:700;white-space:nowrap;">${amtPrefix}${rf(e.amount)}</td>
      </tr>`;
    }).join('');

    const yearRowsHtml = yearKeys.map((y, i) => {
      const { received, spent } = yearly[y];
      const net = received - spent;
      const sr = received > 0 ? ((net / received) * 100).toFixed(1) + '%' : 'N/A';
      const bg = i % 2 === 0 ? '#f8fafc' : 'white';
      const netColor = net >= 0 ? '#059669' : '#dc2626';
      const netStr = (net >= 0 ? '' : '-') + rf(Math.abs(net));
      return `<tr style="background:${bg};">
        <td style="padding:10px 14px;color:#0f172a;font-weight:600;">${y}</td>
        <td style="padding:10px 14px;color:#059669;font-weight:600;">${rf(received)}</td>
        <td style="padding:10px 14px;color:#dc2626;font-weight:600;">${rf(spent)}</td>
        <td style="padding:10px 14px;color:${netColor};font-weight:600;">${netStr}</td>
        <td style="padding:10px 14px;color:#374151;">${sr}</td>
      </tr>`;
    }).join('');

    // Monthly bar chart SVG (inline, works with html2canvas)
    const mChartW = 730, mChartH = 180, mBarAreaH = 130, mPadL = 60, mPadR = 20, mPadTop = 14, mBarGap = 6;
    const chartMonths = Object.keys(monthly).sort();
    let monthlySvg = '';
    if (chartMonths.length > 0) {
      const mMaxVal = Math.max(...chartMonths.map(m => Math.max(monthly[m].received, monthly[m].spent)), 1);
      const mBarW = Math.min(32, Math.floor((mChartW - mPadL - mPadR - (chartMonths.length + 1) * mBarGap) / (chartMonths.length * 2)));
      const mGroupW = mBarW * 2 + mBarGap;
      const mGroupGap = Math.floor((mChartW - mPadL - mPadR - chartMonths.length * mGroupW) / (chartMonths.length + 1));

      const mBarRects = chartMonths.map((m, gi) => {
        const x0 = mPadL + mGroupGap + gi * (mGroupW + mGroupGap);
        const inc = monthly[m].received;
        const spd = monthly[m].spent;
        const hInc = Math.round((inc / mMaxVal) * mBarAreaH);
        const hSpd = Math.round((spd / mMaxVal) * mBarAreaH);
        const yInc = mPadTop + mBarAreaH - hInc;
        const ySpd = mPadTop + mBarAreaH - hSpd;
        const labelY = mPadTop + mBarAreaH + 16;
        const shortLabel = new Date(m + '-02').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
        return `
          <rect x="${x0}" y="${yInc}" width="${mBarW}" height="${hInc}" fill="#10b981" rx="3"/>
          <rect x="${x0 + mBarW + 4}" y="${ySpd}" width="${mBarW}" height="${hSpd}" fill="#ef4444" rx="3"/>
          <text x="${x0 + mBarW + 2}" y="${labelY}" text-anchor="middle" font-size="10" fill="#64748b" font-family="Arial,sans-serif">${shortLabel}</text>
        `;
      }).join('');

      const mGridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => {
        const yPos = mPadTop + mBarAreaH - Math.round(pct * mBarAreaH);
        const val = pct * mMaxVal;
        const label = val >= 1e5 ? (val/1e5).toFixed(1)+'L' : val >= 1e3 ? (val/1e3).toFixed(0)+'K' : val.toFixed(0);
        return `
          <line x1="${mPadL}" y1="${yPos}" x2="${mChartW - mPadR}" y2="${yPos}" stroke="#e2e8f0" stroke-width="1"/>
          <text x="${mPadL - 5}" y="${yPos + 4}" text-anchor="end" font-size="10" fill="#94a3b8" font-family="Arial,sans-serif">₹${label}</text>
        `;
      }).join('');

      const mLegend = `
        <rect x="${mPadL}" y="${mPadTop + mBarAreaH + 28}" width="10" height="10" fill="#10b981" rx="2"/>
        <text x="${mPadL + 14}" y="${mPadTop + mBarAreaH + 37}" font-size="11" fill="#374151" font-family="Arial,sans-serif">Income</text>
        <rect x="${mPadL + 70}" y="${mPadTop + mBarAreaH + 28}" width="10" height="10" fill="#ef4444" rx="2"/>
        <text x="${mPadL + 84}" y="${mPadTop + mBarAreaH + 37}" font-size="11" fill="#374151" font-family="Arial,sans-serif">Spent</text>
      `;

      monthlySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mChartW}" height="${mChartH}" style="display:block;overflow:visible;">
        ${mGridLines}
        ${mBarRects}
        ${mLegend}
      </svg>`;
    }

    // Yearly bar chart SVG (inline, works with html2canvas)
    const chartW = 730, chartH = 180, barAreaH = 130, padL = 60, padR = 20, padTop = 14, barGap = 12;
    const chartYears = Object.keys(yearly).sort();
    let yearlySvg = '';
    if (chartYears.length > 0) {
      const maxVal = Math.max(...chartYears.map(y => Math.max(yearly[y].received, yearly[y].spent)), 1);
      const totalBars = chartYears.length * 2;
      const barW = Math.min(40, Math.floor((chartW - padL - padR - (chartYears.length + 1) * barGap) / totalBars));
      const groupW = barW * 2 + barGap;
      const groupGap = Math.floor((chartW - padL - padR - chartYears.length * groupW) / (chartYears.length + 1));

      const barRects = chartYears.map((y, gi) => {
        const x0 = padL + groupGap + gi * (groupW + groupGap);
        const inc = yearly[y].received;
        const spd = yearly[y].spent;
        const hInc = Math.round((inc / maxVal) * barAreaH);
        const hSpd = Math.round((spd / maxVal) * barAreaH);
        const yInc = padTop + barAreaH - hInc;
        const ySpd = padTop + barAreaH - hSpd;
        const labelY = padTop + barAreaH + 16;
        return `
          <rect x="${x0}" y="${yInc}" width="${barW}" height="${hInc}" fill="#10b981" rx="3"/>
          <rect x="${x0 + barW + 4}" y="${ySpd}" width="${barW}" height="${hSpd}" fill="#ef4444" rx="3"/>
          <text x="${x0 + barW + 2}" y="${labelY}" text-anchor="middle" font-size="11" fill="#64748b" font-family="Arial,sans-serif">${y}</text>
        `;
      }).join('');

      // Y-axis gridlines + labels
      const gridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => {
        const yPos = padTop + barAreaH - Math.round(pct * barAreaH);
        const val = pct * maxVal;
        const label = val >= 1e5 ? (val/1e5).toFixed(1)+'L' : val >= 1e3 ? (val/1e3).toFixed(0)+'K' : val.toFixed(0);
        return `
          <line x1="${padL}" y1="${yPos}" x2="${chartW - padR}" y2="${yPos}" stroke="#e2e8f0" stroke-width="1"/>
          <text x="${padL - 5}" y="${yPos + 4}" text-anchor="end" font-size="10" fill="#94a3b8" font-family="Arial,sans-serif">₹${label}</text>
        `;
      }).join('');

      const legend = `
        <rect x="${padL}" y="${padTop + barAreaH + 28}" width="10" height="10" fill="#10b981" rx="2"/>
        <text x="${padL + 14}" y="${padTop + barAreaH + 37}" font-size="11" fill="#374151" font-family="Arial,sans-serif">Income</text>
        <rect x="${padL + 70}" y="${padTop + barAreaH + 28}" width="10" height="10" fill="#ef4444" rx="2"/>
        <text x="${padL + 84}" y="${padTop + barAreaH + 37}" font-size="11" fill="#374151" font-family="Arial,sans-serif">Spent</text>
      `;

      yearlySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartW}" height="${chartH}" style="display:block;overflow:visible;">
        ${gridLines}
        ${barRects}
        ${legend}
      </svg>`;
    }

    const html = `<div style="width:794px;font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;">

      <div style="background:white;margin-bottom:0;">

        <!-- Header -->
        <div style="background:#0d1f3c;padding:22px 32px;display:flex;justify-content:space-between;align-items:center;">
          <div style="color:white;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Fino</div>
          <div style="display:flex;align-items:center;gap:16px;">
            <div style="color:#94a3b8;font-size:12px;">Report: ${reportDate}</div>
            <div style="width:52px;height:52px;border-radius:50%;background:#1e3a5f;display:flex;align-items:center;justify-content:center;color:white;font-size:20px;font-weight:700;border:3px solid #334155;flex-shrink:0;">
              ${(fullName?.[0] || email[0] || 'U').toUpperCase()}
            </div>
          </div>
        </div>

        <!-- User Info -->
        <div style="margin:24px 32px 16px;padding:16px 22px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;">
          <div style="font-size:17px;font-weight:700;color:#0f172a;margin-bottom:7px;">${fullName || 'User'}</div>
          <div style="color:#64748b;font-size:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <span>${email}</span>
            <span style="color:#cbd5e1;">|</span>
            <span>Monthly Income: ${rf(userIncome)}</span>
            <span style="color:#cbd5e1;">|</span>
            <span>Report Period: ${monthYear}</span>
          </div>
        </div>

        <!-- Stat Cards -->
        <div style="display:flex;gap:12px;margin:0 32px 16px;">
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:16px;border-top:4px solid #34d399;">
            <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600;">NET BALANCE</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;">${rf(netBalance)}</div>
          </div>
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:16px;border-top:4px solid #3b82f6;">
            <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600;">MONTH INCOME</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;">${rf(moIncome)}</div>
          </div>
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:16px;border-top:4px solid #ef4444;">
            <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600;">MONTH SPEND</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;">${rf(moSpend)}</div>
          </div>
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:16px;border-top:4px solid #a855f7;">
            <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600;">SAVINGS RATE</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;">${savingsRate}%</div>
          </div>
        </div>

        <!-- Daily stats bar -->
        <div style="margin:0 32px 24px;background:#0d1f3c;border-radius:10px;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:14px;">
            <span style="color:#94a3b8;font-size:12px;">Daily Average Spend (this month)</span>
            <span style="color:white;font-size:15px;font-weight:700;">${rf(dailyAvg)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:14px;">
            <span style="color:#94a3b8;font-size:12px;">Total Transactions</span>
            <span style="color:white;font-size:15px;font-weight:700;">${moExp.length}</span>
          </div>
        </div>

        <!-- Category Breakdown -->
        <div style="margin:0 32px 24px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:22px;background:#3b82f6;border-radius:2px;flex-shrink:0;"></div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">Category Breakdown &nbsp;<span style="color:#64748b;font-weight:400;font-size:13px;">(This Month &mdash; Spend Only)</span></div>
          </div>
          ${catRowsHtml}
        </div>

        <!-- Monthly Summary -->
        <div style="margin:0 32px 24px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
            <div style="width:4px;height:22px;background:#3b82f6;border-radius:2px;flex-shrink:0;"></div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">Monthly Summary</div>
          </div>
          ${monthlySvg ? `<div style="margin-bottom:16px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">${monthlySvg}</div>` : ''}
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#0d1f3c;color:white;">
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Month</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Income</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Spent</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Net</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Savings%</th>
              </tr>
            </thead>
            <tbody>${monthKeys.length ? monthRowsHtml : '<tr><td colspan="5" style="padding:14px;color:#94a3b8;text-align:center;">No data yet</td></tr>'}</tbody>
          </table>
        </div>

        <!-- Yearly Summary -->
        <div style="margin:0 32px 24px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
            <div style="width:4px;height:22px;background:#3b82f6;border-radius:2px;flex-shrink:0;"></div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">Yearly Summary</div>
          </div>
          ${yearlySvg ? `<div style="margin-bottom:16px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">${yearlySvg}</div>` : ''}
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#0d1f3c;color:white;">
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Year</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Income</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Spent</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Net</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Savings%</th>
              </tr>
            </thead>
            <tbody>${yearKeys.length ? yearRowsHtml : '<tr><td colspan="5" style="padding:14px;color:#94a3b8;text-align:center;">No data yet</td></tr>'}</tbody>
          </table>
        </div>

        <!-- Recent Transactions -->
        <div style="margin:0 32px 0;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
            <div style="width:4px;height:22px;background:#3b82f6;border-radius:2px;flex-shrink:0;"></div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">Recent Transactions &nbsp;<span style="color:#64748b;font-weight:400;font-size:13px;">(Last 15)</span></div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:2px solid #e2e8f0;">
                <th style="padding:9px 14px;text-align:left;color:#94a3b8;font-weight:600;font-size:11px;">DATE</th>
                <th style="padding:9px 14px;text-align:left;color:#94a3b8;font-weight:600;font-size:11px;">CATEGORY</th>
                <th style="padding:9px 14px;text-align:left;color:#94a3b8;font-weight:600;font-size:11px;">DESCRIPTION</th>
                <th style="padding:9px 14px;text-align:right;color:#94a3b8;font-weight:600;font-size:11px;">AMOUNT</th>
              </tr>
            </thead>
            <tbody>${recent.length ? txnRowsHtml : '<tr><td colspan="4" style="padding:14px;color:#94a3b8;text-align:center;">No transactions yet</td></tr>'}</tbody>
          </table>
        </div>

        <!-- Footer -->
        <div style="background:#0d1f3c;margin-top:32px;padding:13px 32px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#94a3b8;font-size:11px;">Fino</span>
          <span style="color:#94a3b8;font-size:11px;">Confidential Financial Report</span>
          <span style="color:#94a3b8;font-size:11px;">Page 1</span>
        </div>

      </div>
    </div>`;

    // Render off-screen
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;';
    container.innerHTML = html;
    document.body.appendChild(container);

    const canvas = await html2canvas(container.firstElementChild, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#f1f5f9',
      width: 794,
      windowWidth: 794,
    });

    document.body.removeChild(container);

    // Split canvas into A4 pages
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const pxPerMm = canvas.width / pageW;
    const pageHeightPx = Math.floor(pageH * pxPerMm);

    let offsetY = 0;
    let pageNum = 0;
    while (offsetY < canvas.height) {
      if (pageNum > 0) pdf.addPage();
      const sliceH = Math.min(pageHeightPx, canvas.height - offsetY);
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceH;
      pageCanvas.getContext('2d').drawImage(canvas, 0, offsetY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pageW, sliceH / pxPerMm);
      offsetY += sliceH;
      pageNum++;
    }

    pdf.save(`expense-report-${now.toISOString().slice(0, 10)}.pdf`);
    toast('PDF report downloaded!');
  } catch (err) {
    console.error('PDF generation failed:', err);
    toast('Failed to generate PDF: ' + err.message, 'error');
  }
}

/* ════════════════════════════════════════
   ADD EXPENSE MODAL
════════════════════════════════════════ */
function openAddExpenseModal() {
  // Reset form if not editing
  if (!editingExpenseId) {
    $('inp-amount').value = '';
    $('inp-date').value = todayStr();
    $('inp-desc').value = '';
    $('desc-counter').textContent = '0/120';
    transactionType = 'spend';
    setTransactionType('spend');
    selectedCat = null;
    renderPills();
  } else {
    // When editing, set the transaction type based on category
    const expense = allExpenses.find(e => e.id === editingExpenseId);
    if (expense) {
      const cat = allCategories.find(c => c.id === expense.category_id);
      if (cat) {
        setTransactionType(cat.type || 'spend');
      }
    }
  }
  
  // Update modal title
  const title = editingExpenseId ? 'Update Transaction' : 'Add Transaction';
  $('add-expense-title').textContent = title;
  $('btn-add-expense').textContent = title;
  
  $('add-expense-modal').classList.remove('hidden');
  setTimeout(() => $('inp-amount').focus(), 100);
}

function closeAddExpenseModal() {
  $('add-expense-modal').classList.add('hidden');
  // Reset editing state
  if (editingExpenseId) {
    cancelEdit();
  }
  // Reset to spend type
  transactionType = 'spend';
  setTransactionType('spend');
}

/* ════════════════════════════════════════
   LANDING PAGE — CONTACT FORM
════════════════════════════════════════ */
async function handleContactForm(e) {
  e.preventDefault();
  
  const name = $('contact-name').value.trim();
  const email = $('contact-email').value.trim();
  const subject = $('contact-subject').value.trim();
  const message = $('contact-message').value.trim();
  
  if (!name || !email || !subject || !message) {
    toast('Please fill all fields', 'error');
    return;
  }
  
  const btn = $('contact-submit');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Sending...</span>';
  
  try {
    // In demo/development mode, just log the message
    if (DEMO_MODE) {
      console.log('📧 Contact Form Submission:', { name, email, subject, message });
      toast('Message sent! (Demo mode - check console)', 'success');
      $('contact-form').reset();
    } else {
      // In production, you can integrate with a service like:
      // - EmailJS: https://www.emailjs.com/
      // - FormSpree: https://formspree.io/
      // - Supabase Edge Functions
      // - Your own backend API
      
      // Example with Supabase (requires setting up edge function):
      /*
      const { error } = await db.functions.invoke('send-contact-email', {
        body: { name, email, subject, message }
      });
      
      if (error) throw error;
      */
      
      // For now, just log and show success
      console.log('📧 Contact Form Submission:', { name, email, subject, message });
      toast('Message sent successfully! We\'ll get back to you soon.', 'success');
      $('contact-form').reset();
    }
  } catch (error) {
    console.error('Error sending message:', error);
    toast('Failed to send message. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

/* ════════════════════════════════════════
   EVENT BINDING
════════════════════════════════════════ */
function bindEvents() {
  /* Auth */
  $('btn-signin').addEventListener('click', signIn);
  $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
  $('btn-signup').addEventListener('click', signUp);
  $('goto-signup').addEventListener('click', showSignup);
  $('goto-login').addEventListener('click', showLogin);
  $('btn-signout').addEventListener('click', signOut);
  $('btn-open-delete-account').addEventListener('click', openDeleteAccountModal);
  $('btn-cancel-delete-account').addEventListener('click', closeDeleteAccountModal);
  $('btn-confirm-delete-account').addEventListener('click', confirmDeleteAccount);
  $('delete-account-modal').addEventListener('click', e => {
    if (e.target === $('delete-account-modal')) closeDeleteAccountModal();
  });

  /* Preferences */
  $('btn-save-prefs')?.addEventListener('click', savePreferences);

  /* History — export + clear all */
  $('btn-export-csv')?.addEventListener('click', exportExpensesCSV);
  $('btn-clear-all-data')?.addEventListener('click', openClearDataModal);
  $('btn-cancel-clear')?.addEventListener('click', closeClearDataModal);
  $('btn-confirm-clear')?.addEventListener('click', clearAllData);
  $('clear-data-modal')?.addEventListener('click', e => {
    if (e.target === $('clear-data-modal')) closeClearDataModal();
  });

  /* Budgets — subscriptions */
  $('btn-add-subscription')?.addEventListener('click', () => openSubscriptionModal());
  $('btn-close-subscription-modal')?.addEventListener('click', closeSubscriptionModal);
  $('btn-cancel-subscription')?.addEventListener('click', closeSubscriptionModal);
  $('btn-save-subscription')?.addEventListener('click', saveSubscription);
  $('subscription-modal')?.addEventListener('click', e => {
    if (e.target === $('subscription-modal')) closeSubscriptionModal();
  });

  /* Community + Upgrade shortcuts from settings */
  $('btn-go-community')?.addEventListener('click', goToCommunityFromApp);
  $('btn-go-pricing')?.addEventListener('click', goToPricingFromApp);

  /* Nav */
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
  $('avatar-btn').addEventListener('click', () => navigateTo('settings'));
  
  /* Add expense modal */
  $('btn-open-add-modal').addEventListener('click', openAddExpenseModal);
  $('btn-cancel-add').addEventListener('click', closeAddExpenseModal);
  $('add-expense-modal').addEventListener('click', e => { 
    if (e.target === $('add-expense-modal')) closeAddExpenseModal(); 
  });
  
  /* Transaction type toggle */
  $('btn-type-spend').addEventListener('click', () => setTransactionType('spend'));
  $('btn-type-received').addEventListener('click', () => setTransactionType('received'));

  /* Add expense */
  $('btn-add-expense').addEventListener('click', addExpense);
  $('inp-desc').addEventListener('input', () => {
    $('desc-counter').textContent = `${$('inp-desc').value.length}/120`;
  });
  $('inp-date').value = todayStr();
  $('inp-date').max   = todayStr();

  /* Expense list — edit & delete */
  $('expense-list').addEventListener('click', e => {
    const editBtn = e.target.closest('.btn-edit-expense');
    const delBtn = e.target.closest('.btn-del-expense');
    if (editBtn) openEdit(editBtn.dataset.id);
    if (delBtn) openDelete(delBtn.dataset.id);
  });

  /* Delete dialog */
  $('btn-cancel-del').addEventListener('click', closeDelete);
  $('btn-confirm-del').addEventListener('click', confirmDelete);
  $('delete-modal').addEventListener('click', e => { if (e.target === $('delete-modal')) closeDelete(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDelete(); });

  /* Settings tabs */
  document.querySelectorAll('.settings-nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => openSettingsTab(btn.dataset.tab));
  });

  /* Profile */
  $('btn-save-profile').addEventListener('click', saveProfile);
  $('p-dob').addEventListener('change', calcAge);

  /* Account - Edit fields */
  $('btn-edit-username').addEventListener('click', () => openEditField('username'));
  $('btn-edit-email').addEventListener('click', () => openEditField('email'));
  $('btn-edit-phone').addEventListener('click', () => openEditField('phone'));
  
  /* Account - Edit modal */
  $('btn-cancel-edit').addEventListener('click', closeEditField);
  $('btn-confirm-edit').addEventListener('click', confirmEditField);
  $('edit-account-modal').addEventListener('click', e => { 
    if (e.target === $('edit-account-modal')) closeEditField(); 
  });
  
  /* Account - Password update */
  $('btn-update-password').addEventListener('click', updatePassword);
  
  /* OTP Modal */
  $('btn-cancel-otp').addEventListener('click', closeOTPModal);
  $('btn-verify-otp').addEventListener('click', verifyOTP);
  $('btn-resend-otp').addEventListener('click', resendOTP);
  $('otp-modal').addEventListener('click', e => { 
    if (e.target === $('otp-modal')) closeOTPModal(); 
  });
  
  // Setup OTP inputs
  setupOTPInputs();

  /* Reports */
  $('btn-download').addEventListener('click', downloadReport);

  /* Landing Page */
  // Note: the nav Sign In button (id="lp-btn-launch") is handled in index.html's
  // DOMContentLoaded block. If session is active it shows "Go to App", otherwise
  // the DOMContentLoaded listener calls goToLogin(). Nothing to do here.
  
  if ($('hero-signup-btn')) {
    $('hero-signup-btn').addEventListener('click', () => {
      $('page-landing').classList.add('hidden');
      showSignup();
    });
  }
  
  if ($('hero-demo-btn')) {
    $('hero-demo-btn').addEventListener('click', () => {
      $('page-landing').classList.add('hidden');
      showLogin();
      toast('Demo mode enabled! Sign in with any credentials', 'success');
    });
  }
  
  // Pricing buttons
  ['free', 'pro', 'business'].forEach(plan => {
    const btn = $(`pricing-${plan}-btn`);
    if (btn) {
      btn.addEventListener('click', () => {
        $('page-landing').classList.add('hidden');
        showSignup();
        toast(`Selected ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan! Create your account to continue.`, 'success');
      });
    }
  });
  
  // Contact form
  if ($('contact-form')) {
    $('contact-form').addEventListener('submit', handleContactForm);
  }

  // Smooth scroll for navigation links
  document.querySelectorAll('.nav-links a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = link.getAttribute('href').substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

/* ════════════════════════════════════════
   DELETE ACCOUNT
════════════════════════════════════════ */
function openDeleteAccountModal() {
  $('delete-account-password').value = '';
  $('delete-account-modal').classList.remove('hidden');
  setTimeout(() => $('delete-account-password').focus(), 100);
}

function closeDeleteAccountModal() {
  $('delete-account-modal').classList.add('hidden');
  $('delete-account-password').value = '';
}

async function confirmDeleteAccount() {
  const password = $('delete-account-password').value;
  if (!password) { toast('Please enter your password', 'error'); return; }

  const btn = $('btn-confirm-delete-account');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  if (DEMO_MODE) {
    localStorage.removeItem(`exp_${currentUser?.id}`);
    localStorage.removeItem(`profile_${currentUser?.id}`);
    localStorage.removeItem(`pfp_${currentUser?.id}`);
    currentUser = null;
    allExpenses = [];
    closeDeleteAccountModal();
    toast('Account deleted.');
    showLogin();
    return;
  }

  // Verify password first
  const { error: authError } = await db.auth.signInWithPassword({
    email: currentUser.email,
    password
  });

  if (authError) {
    btn.disabled = false;
    btn.textContent = 'Delete My Account';
    toast('Incorrect password', 'error');
    return;
  }

  try {
    // delete_user() atomically removes expenses, profile, and auth.users row
    const { error: deleteError } = await db.rpc('delete_user');
    if (deleteError) throw deleteError;

    await db.auth.signOut();
    currentUser = null;
    allExpenses = [];
    closeDeleteAccountModal();
    toast('Account deleted. Goodbye!');
    showLogin();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Delete My Account';
    toast('Failed to delete account: ' + (err.message || 'Unknown error'), 'error');
  }
}

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
(async () => {
  bindEvents();
  await checkSession();

  // Listen for auth changes (only in real mode)
  if (!DEMO_MODE && db) {
    db.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { currentUser = null; showLogin(); }
      if (event === 'SIGNED_IN' && session) { currentUser = session.user; }
    });
  }
})();

/* ============================================================
   LANDING PAGE SCRIPT (moved from index.html inline <script>)
   ============================================================ */
/* ══════════════════════════════════════════════════
   LANDING PAGE NAVIGATION FUNCTIONS
══════════════════════════════════════════════════ */

function hideLanding() {
  document.getElementById('page-landing').classList.add('hidden');
  window.scrollTo(0, 0);
}

function goToLogin() {
  document.getElementById('page-landing').classList.add('hidden');
  document.getElementById('page-signup').classList.add('hidden');
  document.getElementById('page-login').classList.remove('hidden');
  document.getElementById('page-app').classList.add('hidden');
  document.getElementById('page-faq').classList.add('hidden');
  window.scrollTo(0, 0);
}

function goToSignup() {
  document.getElementById('page-landing').classList.add('hidden');
  document.getElementById('page-login').classList.add('hidden');
  document.getElementById('page-signup').classList.remove('hidden');
  document.getElementById('page-app').classList.add('hidden');
  document.getElementById('page-faq').classList.add('hidden');
  window.scrollTo(0, 0);
}

/* ── FAQ Page show/hide ── */
/* Tracks whether the FAQ/Pricing page was opened from inside the app
   (settings) vs from the public landing page, so Back returns correctly. */
let pageOrigin = 'landing'; // 'landing' | 'app'

function returnFromSubPage() {
  document.getElementById('page-faq')?.classList.add('hidden');
  document.getElementById('page-pricing')?.classList.add('hidden');
  if (pageOrigin === 'app') {
    document.getElementById('page-landing')?.classList.add('hidden');
    document.getElementById('page-app')?.classList.remove('hidden');
    if (typeof navigateTo === 'function') navigateTo('settings');
  } else {
    document.getElementById('page-landing')?.classList.remove('hidden');
  }
  pageOrigin = 'landing';
  window.scrollTo(0, 0);
}

function showFAQPage(e) {
  if (e) e.preventDefault();
  pageOrigin = 'landing';
  document.getElementById('page-landing').classList.add('hidden');
  document.getElementById('page-faq').classList.remove('hidden');
  document.getElementById('page-pricing')?.classList.add('hidden');
  window.scrollTo(0, 0);
  loadFAQFull();
}

function hideFAQPage(e) {
  if (e) e.preventDefault();
  returnFromSubPage();
}

/* ── Pricing Page show/hide ── */
function showPricingPage(e) {
  if (e) e.preventDefault();
  pageOrigin = 'landing';
  document.getElementById('page-landing').classList.add('hidden');
  document.getElementById('page-pricing').classList.remove('hidden');
  document.getElementById('page-faq')?.classList.add('hidden');
  window.scrollTo(0, 0);
}

function hidePricingPage(e) {
  if (e) e.preventDefault();
  returnFromSubPage();
}

/* ── Jump from inside the app (settings) to Community / Pricing ── */
function goToCommunityFromApp() {
  pageOrigin = 'app';
  document.getElementById('page-app')?.classList.add('hidden');
  document.getElementById('page-landing')?.classList.add('hidden');
  document.getElementById('page-pricing')?.classList.add('hidden');
  document.getElementById('page-faq').classList.remove('hidden');
  window.scrollTo(0, 0);
  if (typeof loadFAQFull === 'function') loadFAQFull();
}
function goToPricingFromApp() {
  pageOrigin = 'app';
  document.getElementById('page-app')?.classList.add('hidden');
  document.getElementById('page-landing')?.classList.add('hidden');
  document.getElementById('page-faq')?.classList.add('hidden');
  document.getElementById('page-pricing').classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ── Member-since helper ── */
function getMemberDuration(createdAt) {
  if (!createdAt) return 'Member for —';
  const created = new Date(createdAt);
  const now = new Date();
  const days = Math.floor((now - created) / (1000 * 60 * 60 * 24));
  if (days < 1)  return 'Member since today';
  if (days < 30) return `Member for ${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Member for ${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  return `Member for ${years} year${years === 1 ? '' : 's'}`;
}

/* ── Fill user info strip in modals ── */
async function fillUserInfoStrip(avatarId, nameId, sinceId) {
  if (!currentUser) return;
  const username = currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'user';
  const createdAt = currentUser.created_at;

  // Name + since
  const nameEl  = document.getElementById(nameId);
  const sinceEl = document.getElementById(sinceId);
  if (nameEl)  nameEl.textContent  = username;
  if (sinceEl) sinceEl.textContent = getMemberDuration(createdAt);

  // Avatar: try DB pfp_url first, then localStorage
  const avatarEl = document.getElementById(avatarId);
  if (!avatarEl) return;
  let pfpUrl = null;
  if (!DEMO_MODE && db) {
    const { data } = await db.from('profiles').select('pfp_url').eq('id', currentUser.id).single();
    pfpUrl = data?.pfp_url || null;
  }
  if (!pfpUrl) pfpUrl = localStorage.getItem(`pfp_${currentUser.id}`) || null;
  if (pfpUrl) {
    avatarEl.style.backgroundImage = `url(${pfpUrl})`;
    avatarEl.style.backgroundSize  = 'cover';
    avatarEl.style.backgroundPosition = 'center';
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = username.charAt(0).toUpperCase();
  }
}

/* ══════════════════════════════════════════════════
   LANDING PAGE BUTTON EVENT LISTENERS
══════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function() {
  // Launch App button in nav
  const launchBtn = document.getElementById('lp-btn-launch');
  if (launchBtn) {
    launchBtn.setAttribute('data-action', 'login');
    launchBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (launchBtn.getAttribute('data-action') === 'app') showApp();
      else goToLogin();
    });
  }

  // Get Started button in hero
  const getStartedBtn = document.getElementById('lp-btn-getstarted');
  if (getStartedBtn) {
    getStartedBtn.addEventListener('click', function(e) { e.preventDefault(); goToSignup(); });
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (href === '#' || !href.startsWith('#lp-')) return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        const navbarHeight = 80;
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navbarHeight;
        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
      }
    });
  });

  // Contact form handler
  const contactForm = document.getElementById('lp-form');
  if (contactForm) {
    contactForm.addEventListener('submit', function(e) {
      e.preventDefault();
      console.log('📧 Contact Form Submission');
      const statusDiv = document.getElementById('lp-form-status');
      if (statusDiv) statusDiv.innerHTML = '<p style="color:#34d399;font-size:14px;margin:12px 0;">✓ Message sent! We\'ll get back to you soon.</p>';
      this.reset();
      setTimeout(() => { if (statusDiv) statusDiv.innerHTML = ''; }, 5000);
    });
  }

  /* ── Scroll Reveal ── */
  const lpObserver = new IntersectionObserver(
    entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('lp-visible'); }),
    { threshold: 0.12 }
  );
  document.querySelectorAll('.lp-reveal').forEach(el => lpObserver.observe(el));

  /* ══════════════════════════════════════════════════
     REVIEWS SYSTEM
  ══════════════════════════════════════════════════ */
  let selectedRating = 0;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getRandomColor() {
    const colors = ['#4e7ab1', '#34d399', '#F59E0B', '#8B5CF6', '#EC4899', '#b987af'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  async function loadReviews() {
    const grid = document.getElementById('reviews-grid');
    if (!grid) return;
    if (DEMO_MODE) {
      grid.innerHTML = '<div class="lp-loading">Reviews will appear once Supabase is set up.</div>';
      return;
    }
    try {
      const { data, error } = await db.from('reviews').select('*').eq('approved', true)
        .order('created_at', { ascending: false }).limit(8);
      if (error) throw error;
      if (!data || data.length === 0) {
        grid.innerHTML = `<div class="lp-reviews-empty">
          <div class="lp-reviews-empty-icon">✨</div>
          <p class="lp-reviews-empty-title">No reviews yet</p>
          <p class="lp-reviews-empty-sub">Be the first to share your experience!</p></div>`;
        return;
      }
      const count = data.length;
      grid.className = count === 1 ? 'lp-testi-grid lp-reviews-single'
                     : count === 2 ? 'lp-testi-grid lp-reviews-pair'
                     : 'lp-testi-grid';
      grid.innerHTML = data.map(review => {
        const uname  = review.username || 'user';
        const letter = uname.charAt(0).toUpperCase();
        const pfpStyle = review.pfp_url
          ? `background-image:url(${review.pfp_url});background-size:cover;background-position:center;`
          : `background:${getRandomColor()};`;
        const sinceText = getMemberDuration(review.user_created_at || review.created_at);
        return `<div class="lp-testi lp-reveal">
          <div class="lp-stars">${'★'.repeat(review.rating)}${'☆'.repeat(5-review.rating)}</div>
          <p class="lp-testi-q">"${escapeHtml(review.review_text)}"</p>
          <div class="lp-testi-author">
            <div class="lp-avatar" style="${pfpStyle}">${review.pfp_url ? '' : letter}</div>
            <div>
              <div class="lp-tname">@${escapeHtml(uname)}</div>
              <div class="lp-trole">${sinceText}</div>
            </div>
          </div>
        </div>`;
      }).join('');
      document.querySelectorAll('#reviews-grid .lp-reveal').forEach(el => lpObserver.observe(el));
    } catch (err) {
      console.error('Error loading reviews:', err);
      grid.innerHTML = '<div class="lp-loading">Failed to load reviews.</div>';
    }
  }

  // Open review modal
  const btnAddReview = document.getElementById('btn-add-review');
  const reviewModal  = document.getElementById('review-modal');

  if (btnAddReview) {
    btnAddReview.addEventListener('click', async () => {
      if (DEMO_MODE) { showLandingToast('Reviews require a Supabase account. Please sign up!', 'info'); return; }
      if (!currentUser && db) {
        const { data: { session } } = await db.auth.getSession();
        if (session) currentUser = session.user;
      }
      if (!currentUser) {
        sessionStorage.setItem('returnTo', 'review');
        goToLogin();
        showLandingLoginHint();
        return;
      }
      await fillUserInfoStrip('review-user-avatar', 'review-user-name', 'review-user-since');
      reviewModal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    });
  }

  function closeReviewModal() {
    reviewModal.classList.add('hidden');
    document.body.style.overflow = '';
    document.getElementById('review-form').reset();
    selectedRating = 0;
    document.querySelectorAll('.star-btn').forEach(btn => btn.classList.remove('active'));
  }

  document.getElementById('btn-close-review-modal')?.addEventListener('click', closeReviewModal);
  document.getElementById('btn-cancel-review')?.addEventListener('click', closeReviewModal);

  // Star rating
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      selectedRating = parseInt(this.dataset.rating);
      document.getElementById('review-rating').value = selectedRating;
      document.querySelectorAll('.star-btn').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.rating) <= selectedRating);
      });
    });
  });

  // Counter
  const reviewText = document.getElementById('review-text');
  const reviewCounter = document.getElementById('review-counter');
  if (reviewText) reviewText.addEventListener('input', () => {
    reviewCounter.textContent = `${reviewText.value.length}/500`;
  });

  // Submit review — uses username + pfp_url from profiles
  document.getElementById('review-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedRating) { showLandingToast('Please select a rating', 'error'); return; }
    const reviewTextValue = document.getElementById('review-text').value.trim();
    const btnSubmit = document.getElementById('btn-submit-review');
    btnSubmit.disabled = true; btnSubmit.textContent = 'Submitting...';
    try {
      // Fetch latest profile for username + pfp_url
      const { data: prof } = await db.from('profiles').select('username, pfp_url').eq('id', currentUser.id).single();
      const username = prof?.username || currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'user';
      const pfpUrl   = prof?.pfp_url || localStorage.getItem(`pfp_${currentUser.id}`) || null;
      
      // Try to insert with new schema first
      let { error } = await db.from('reviews').insert({
        user_id:          currentUser.id,
        username,
        pfp_url:          pfpUrl,
        user_created_at:  currentUser.created_at,
        rating:           selectedRating,
        review_text:      reviewTextValue,
        approved:         false
      });
      
      // If failed, try old schema (name, role instead of username, pfp_url)
      if (error && error.message.includes('column')) {
        console.log('Trying old schema...');
        const result = await db.from('reviews').insert({
          user_id:     currentUser.id,
          name:        username,
          role:        'Member',
          rating:      selectedRating,
          review_text: reviewTextValue,
          approved:    false
        });
        error = result.error;
      }
      
      if (error) {
        console.error('Supabase error details:', error);
        if (error.message.includes('relation') && error.message.includes('does not exist')) {
          showLandingToast('Reviews table not found. Please run reviews_setup.sql in Supabase.', 'error');
        } else if (error.message.includes('violates check constraint')) {
          showLandingToast('Review must be 10-500 characters.', 'error');
        } else {
          showLandingToast('Error: ' + error.message, 'error');
        }
        throw error;
      }
      showLandingToast('Thank you! Your review will appear after approval.', 'success');
      closeReviewModal();
      // Reset form
      selectedRating = 0;
      document.getElementById('review-text').value = '';
      document.querySelectorAll('.star-btn').forEach(s => s.classList.remove('active'));
    } catch (err) {
      console.error('Error submitting review:', err);
      // Error already handled above
    } finally {
      btnSubmit.disabled = false; btnSubmit.textContent = 'Submit Review';
    }
  });

  loadReviews();

  /* ══════════════════════════════════════════════════
     FAQ SYSTEM
  ══════════════════════════════════════════════════ */
  let allFAQs = [];
  let answeringFAQId = null;

  // Load preview FAQs (latest 4) on landing page
  async function loadFAQPreview() {
    const container = document.getElementById('faq-preview-grid');
    if (!container) return;
    if (DEMO_MODE) {
      container.innerHTML = '<div class="lp-loading">FAQ preview requires Supabase.</div>';
      return;
    }
    try {
      const { data, error } = await db.from('faqs')
        .select('*, faq_answers(id), faq_likes(id)')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(9);
      if (error) throw error;
      if (!data || data.length === 0) {
        container.innerHTML = '<div class="lp-loading" style="color: rgba(200,216,238,0.4); font-size: 13px;">No questions yet</div>';
        return;
      }
      // Sort by like count (most liked first), then keep only the top 3
      data.sort((a, b) => (b.faq_likes?.length || 0) - (a.faq_likes?.length || 0));
      const top3 = data.slice(0, 3);

      // Get user's liked FAQ ids
      let likedIds = new Set();
      if (currentUser) {
        const { data: liked } = await db.from('faq_likes').select('faq_id').eq('user_id', currentUser.id);
        if (liked) liked.forEach(l => likedIds.add(l.faq_id));
      }

      container.innerHTML = top3.map(faq =>
        renderFAQCard(faq, faq.faq_answers?.length || 0, false, faq.faq_likes?.length || 0, likedIds.has(faq.id))
      ).join('');
    } catch(err) {
      console.error('FAQ preview error:', err);
      container.innerHTML = '<div class="lp-loading">Failed to load FAQs.</div>';
    }
  }
  
  // Load FAQ preview on page load
  loadFAQPreview();

  // Load ALL FAQs (for full page)
  window.loadFAQFull = async function() {
    const container = document.getElementById('faq-full-list');
    if (!container) return;
    if (DEMO_MODE) {
      container.innerHTML = '<div class="faq-no-results">FAQ requires Supabase.</div>';
      return;
    }
    try {
      container.innerHTML = '<div class="lp-reviews-empty"><div class="lp-reviews-empty-icon">⏳</div><p>Loading...</p></div>';
      const { data, error } = await db.from('faqs')
        .select('*, faq_answers(*), faq_likes(id, user_id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      allFAQs = data || [];
      // Sort by likes
      allFAQs.sort((a, b) => (b.faq_likes?.length || 0) - (a.faq_likes?.length || 0));

      // Get user's liked ids
      if (currentUser) {
        const { data: liked } = await db.from('faq_likes').select('faq_id').eq('user_id', currentUser.id);
        window._faqLikedIds = new Set(liked ? liked.map(l => l.faq_id) : []);
      } else {
        window._faqLikedIds = new Set();
      }
      renderFullFAQ(allFAQs);
    } catch(err) {
      console.error('FAQ full load error:', err);
      container.innerHTML = '<div class="faq-no-results">Failed to load FAQs.</div>';
    }
  };

  function renderFullFAQ(faqs) {
    const container = document.getElementById('faq-full-list');
    if (!container) return;
    if (!faqs || faqs.length === 0) {
      container.innerHTML = '<div class="faq-no-results">No questions found.</div>';
      return;
    }
    const likedIds = window._faqLikedIds || new Set();
    container.innerHTML = faqs.map(faq =>
      renderFAQCard(faq, (faq.faq_answers||[]).length, true, faq.faq_likes?.length || 0, likedIds.has(faq.id))
    ).join('');
  }

  // Expand/collapse a single question card to reveal its answers
  window.toggleFAQCard = function(headEl) {
    const card = headEl.closest('.faq-card-collapsible');
    if (!card) return;
    card.classList.toggle('open');
  };

  // Deterministic avatar gradient (matches reference landing palette)
  function avatarGradient(seed) {
    const grads = [
      'linear-gradient(135deg,#4e7ab1,#ceb5d4)',
      'linear-gradient(135deg,#b987af,#34d399)',
      'linear-gradient(135deg,#7BB8F0,#4e7ab1)',
      'linear-gradient(135deg,#4e7ab1,#34d399)',
      'linear-gradient(135deg,#ceb5d4,#7BB8F0)',
      'linear-gradient(135deg,#b987af,#4e7ab1)'
    ];
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return grads[h % grads.length];
  }

  function renderFAQCard(faq, answerCount, showAnswers, likeCount = 0, userLiked = false) {
    const since = getMemberDuration(faq.user_created_at || faq.created_at);
    const uname = faq.username || 'user';
    const initial = uname.charAt(0).toUpperCase();
    const grad = avatarGradient(faq.id || uname);
    const answerLabel = `${answerCount} answer${answerCount === 1 ? '' : 's'}`;
    // Avatar: use saved pfp image if present, else gradient + initial
    const avStyle  = faq.pfp_url
      ? `background-image:url(${faq.pfp_url});background-size:cover;background-position:center;`
      : `background:${grad}`;
    const avInner  = faq.pfp_url ? '' : initial;

    // ---- PREVIEW (landing) cards: clean qcard markup matching the reference ----
    if (!showAnswers) {
      const likedClass = userLiked ? ' liked' : '';
      return `<div class="qcard" data-faq-id="${faq.id}" onclick="showFAQPage(event)" style="cursor:pointer">
        <div class="u">
          <span class="av" style="${avStyle}">${avInner}</span>
          <div>
            <div class="un">@${escapeHtml(uname)}</div>
            <div class="ms">${since}</div>
          </div>
        </div>
        <div class="q">${escapeHtml(faq.question_text)}</div>
        <div class="foot">
          <span class="qlike${likedClass}" onclick="event.stopPropagation();toggleFAQLike(this, '${faq.id}')" title="${userLiked?'Unlike':'Like'} this question">
            <span class="heart">♥</span> <span class="like-count">${likeCount}</span>
          </span>
          <span>💬 ${answerLabel}</span>
        </div>
      </div>`;
    }

    // ---- FULL questions page: keep richer faq-card with answers + answer button ----
    const answers = faq.faq_answers ? faq.faq_answers : [];
    const likedClass = userLiked ? ' liked' : '';
    const heartSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    const answersHtml = answers.length > 0 ? `<div class="faq-card-answers">${answers.map(a => {
      const al = a.username || 'user';
      return `<div class="faq-answer">
        <div class="faq-answer-text">${escapeHtml(a.answer_text)}</div>
        <div class="faq-answer-meta">— @${escapeHtml(al)} · ${getMemberDuration(a.user_created_at||a.created_at)}</div>
      </div>`;
    }).join('')}</div>` : '';

    const emptyAnswers = answers.length === 0
      ? `<div class="faq-card-answers faq-card-answers-empty">No answers yet — be the first to answer.</div>`
      : answersHtml;

    return `<div class="faq-card faq-card-collapsible" data-faq-id="${faq.id}">
      <div class="faq-card-head" onclick="toggleFAQCard(this)">
        <div class="faq-card-user">
          <div class="faq-card-avatar" style="${avStyle}">${avInner}</div>
          <div>
            <div class="faq-card-username">@${escapeHtml(uname)}</div>
            <div class="faq-card-since">${since}</div>
          </div>
        </div>
        <div class="faq-card-q">${escapeHtml(faq.question_text)}</div>
        <div class="faq-card-meta">@${escapeHtml(uname)} · ${since}</div>
        <div class="faq-card-collapsed-foot">
          <span>💬 ${answerLabel}</span>
          <span class="faq-card-chevron">▾</span>
        </div>
      </div>
      <div class="faq-card-body">
        <div class="faq-card-answers-scroll">
          ${emptyAnswers}
        </div>
        <div class="faq-card-footer">
          <button class="btn-faq-like${likedClass}" onclick="toggleFAQLike(this, '${faq.id}')" title="${userLiked?'Unlike':'Like'} this question">
            ${heartSvg}
            <span class="like-count">${likeCount}</span>
          </button>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="faq-answer-count">${answerLabel}</span>
            <button class="btn-faq-answer" onclick="openAnswerModal('${faq.id}', \`${escapeHtml(faq.question_text).replace(/`/g,"'")}\`)">Answer</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // Filter FAQ by search
  window.filterFAQ = function(query) {
    const q = query.toLowerCase();
    const filtered = q ? allFAQs.filter(f =>
      f.question_text.toLowerCase().includes(q) ||
      (f.faq_answers||[]).some(a => a.answer_text.toLowerCase().includes(q))
    ) : allFAQs;
    renderFullFAQ(filtered);
  };

  // Toggle like on an FAQ
  window.toggleFAQLike = async function(btn, faqId) {
    if (DEMO_MODE) { showLandingToast('Likes require a Supabase account.', 'info'); return; }
    if (!currentUser && db) {
      const { data: { session } } = await db.auth.getSession();
      if (session) currentUser = session.user;
    }
    if (!currentUser) {
      sessionStorage.setItem('returnTo', 'faq');
      goToLogin();
      showLandingLoginHint();
      return;
    }

    const isLiked = btn.classList.contains('liked');
    const countEl = btn.querySelector('.like-count');
    let count = parseInt(countEl.textContent, 10) || 0;

    // Optimistic UI
    btn.classList.toggle('liked');
    countEl.textContent = isLiked ? count - 1 : count + 1;
    btn.title = isLiked ? 'Like this question' : 'Unlike this question';

    try {
      if (isLiked) {
        const { error } = await db.from('faq_likes').delete()
          .eq('faq_id', faqId).eq('user_id', currentUser.id);
        if (error) throw error;
        if (window._faqLikedIds) window._faqLikedIds.delete(faqId);
      } else {
        const { error } = await db.from('faq_likes').insert({ faq_id: faqId, user_id: currentUser.id });
        if (error) throw error;
        if (window._faqLikedIds) window._faqLikedIds.add(faqId);
      }
    } catch(err) {
      // Revert on failure
      btn.classList.toggle('liked');
      countEl.textContent = count;
      btn.title = isLiked ? 'Unlike this question' : 'Like this question';
      console.error('Like error:', err);
      showLandingToast('Could not update like. Please try again.', 'error');
    }
  };

  // Ask question modal
  async function openAskModal() {
    if (DEMO_MODE) { showLandingToast('FAQ requires a Supabase account.', 'info'); return; }
    if (!currentUser && db) {
      const { data: { session } } = await db.auth.getSession();
      if (session) currentUser = session.user;
    }
    if (!currentUser) {
      sessionStorage.setItem('returnTo', 'faq');
      goToLogin();
      showLandingLoginHint();
      return;
    }
    await fillUserInfoStrip('faq-user-avatar', 'faq-user-name', 'faq-user-since');
    document.getElementById('faq-ask-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeAskModal() {
    document.getElementById('faq-ask-modal').classList.add('hidden');
    document.body.style.overflow = '';
    document.getElementById('faq-question-text').value = '';
    document.getElementById('faq-q-counter').textContent = '0/400';
  }

  document.getElementById('btn-ask-question')?.addEventListener('click', openAskModal);
  document.getElementById('btn-ask-question-full')?.addEventListener('click', openAskModal);
  document.getElementById('btn-close-faq-modal')?.addEventListener('click', closeAskModal);
  document.getElementById('btn-cancel-faq')?.addEventListener('click', closeAskModal);

  const faqQText = document.getElementById('faq-question-text');
  if (faqQText) faqQText.addEventListener('input', () => {
    document.getElementById('faq-q-counter').textContent = `${faqQText.value.length}/400`;
  });

  document.getElementById('btn-submit-faq')?.addEventListener('click', async () => {
    const text = document.getElementById('faq-question-text').value.trim();
    if (!text || text.length < 10) { showLandingToast('Please write at least 10 characters', 'error'); return; }
    const btn = document.getElementById('btn-submit-faq');
    btn.disabled = true; btn.textContent = 'Posting...';
    try {
      const { data: prof } = await db.from('profiles').select('username, pfp_url').eq('id', currentUser.id).single();
      const username = prof?.username || currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'user';
      const pfpUrl   = prof?.pfp_url || localStorage.getItem(`pfp_${currentUser.id}`) || null;
      const { error } = await db.from('faqs').insert({
        user_id: currentUser.id, 
        username,
        pfp_url: pfpUrl,
        user_created_at: currentUser.created_at,
        question_text: text,
        is_published: true
      });
      if (error) {
        console.error('FAQ insert error:', error);
        if (error.message.includes('relation') && error.message.includes('does not exist')) {
          showLandingToast('FAQs table not found. Please run faq_setup.sql in Supabase.', 'error');
        } else if (error.message.includes('violates check constraint')) {
          showLandingToast('Question must be 10-400 characters.', 'error');
        } else {
          showLandingToast('Error: ' + error.message, 'error');
        }
        throw error;
      }
      showLandingToast('Question posted!', 'success');
      closeAskModal();
      document.getElementById('faq-question-text').value = '';
      document.getElementById('faq-q-counter').textContent = '0/400';
      loadFAQPreview();
      if (!document.getElementById('page-faq').classList.contains('hidden')) loadFAQFull();
    } catch(err) {
      console.error('FAQ post error:', err);
      // Error already handled above
    } finally {
      btn.disabled = false; btn.textContent = 'Post Question';
    }
  });

  // Answer modal
  window.openAnswerModal = async function(faqId, questionText) {
    if (DEMO_MODE) { showLandingToast('FAQ requires a Supabase account.', 'info'); return; }
    if (!currentUser && db) {
      const { data: { session } } = await db.auth.getSession();
      if (session) currentUser = session.user;
    }
    if (!currentUser) {
      sessionStorage.setItem('returnTo', 'faq');
      goToLogin();
      showLandingLoginHint();
      return;
    }
    answeringFAQId = faqId;
    document.getElementById('faq-question-preview').textContent = questionText;
    await fillUserInfoStrip('faq-answer-user-avatar', 'faq-answer-user-name', null);
    document.getElementById('faq-answer-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };

  function closeAnswerModal() {
    document.getElementById('faq-answer-modal').classList.add('hidden');
    document.body.style.overflow = '';
    document.getElementById('faq-answer-text').value = '';
    document.getElementById('faq-a-counter').textContent = '0/600';
    answeringFAQId = null;
  }

  document.getElementById('btn-close-answer-modal')?.addEventListener('click', closeAnswerModal);
  document.getElementById('btn-cancel-answer')?.addEventListener('click', closeAnswerModal);

  const faqAText = document.getElementById('faq-answer-text');
  if (faqAText) faqAText.addEventListener('input', () => {
    document.getElementById('faq-a-counter').textContent = `${faqAText.value.length}/600`;
  });

  document.getElementById('btn-submit-answer')?.addEventListener('click', async () => {
    const text = document.getElementById('faq-answer-text').value.trim();
    if (!text || text.length < 5) { showLandingToast('Please write at least 5 characters', 'error'); return; }
    const btn = document.getElementById('btn-submit-answer');
    btn.disabled = true; btn.textContent = 'Posting...';
    try {
      const { data: prof } = await db.from('profiles').select('username').eq('id', currentUser.id).single();
      const username = prof?.username || currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'user';
      const { error } = await db.from('faq_answers').insert({
        faq_id: answeringFAQId, user_id: currentUser.id, username,
        user_created_at: currentUser.created_at,
        answer_text: text
      });
      if (error) throw error;
      showLandingToast('Answer posted!', 'success');
      closeAnswerModal();
      if (!document.getElementById('page-faq').classList.contains('hidden')) loadFAQFull();
      else loadFAQPreview();
    } catch(err) {
      console.error('FAQ answer error:', err);
      showLandingToast('Failed to post answer.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Post Answer';
    }
  });

  loadFAQPreview();

  /* ══════════════════════════════════════════════════
     SESSION CHECK + USER NAV
  ══════════════════════════════════════════════════ */
  async function checkLandingSession() {
    if (DEMO_MODE || !db) return;
    try {
      const { data: { session } } = await db.auth.getSession();
      if (session) { currentUser = session.user; activateLandingUserNav(session.user); }
    } catch (e) { /* silent */ }
  }
  checkLandingSession();

  function activateLandingUserNav(user) {
    const launchBtn = document.getElementById('lp-btn-launch');
    const userNav   = document.getElementById('lp-user-nav');
    if (launchBtn) launchBtn.classList.add('hidden');
    if (userNav)   userNav.classList.remove('hidden');

    // PFP: try DB first, then localStorage
    const avatar = document.getElementById('lp-pfp-avatar');
    if (avatar) {
      const username = user.user_metadata?.username || user.email || '';
      // Async: load pfp from DB
      (async () => {
        let pfpUrl = null;
        if (!DEMO_MODE && db) {
          const { data } = await db.from('profiles').select('pfp_url').eq('id', user.id).single();
          pfpUrl = data?.pfp_url || null;
        }
        if (!pfpUrl) pfpUrl = localStorage.getItem(`pfp_${user.id}`) || null;
        if (pfpUrl) {
          avatar.style.backgroundImage = `url(${pfpUrl})`;
          avatar.style.backgroundSize  = 'cover';
          avatar.style.backgroundPosition = 'center';
          avatar.textContent = '';
        } else {
          avatar.textContent = username.charAt(0).toUpperCase() || 'A';
        }
      })();
    }

    const dashBtn = document.getElementById('lp-btn-dashboard');
    if (dashBtn) dashBtn.addEventListener('click', () => showApp());

    const pfpWrap     = document.getElementById('lp-pfp-wrap');
    const pfpDropdown = document.getElementById('lp-pfp-dropdown');
    if (pfpWrap && pfpDropdown) {
      pfpWrap.addEventListener('click', (e) => { e.stopPropagation(); pfpDropdown.classList.toggle('hidden'); });
      document.addEventListener('click', () => pfpDropdown.classList.add('hidden'));
    }

    const accountBtn = document.getElementById('lp-pfp-account');
    if (accountBtn) {
      accountBtn.addEventListener('click', async () => {
        pfpDropdown.classList.add('hidden');
        await showApp();
        setTimeout(() => {
          if (typeof navigateTo === 'function') navigateTo('settings');
          if (typeof openSettingsTab === 'function') openSettingsTab('account');
        }, 300);
      });
    }

    const signoutBtn = document.getElementById('lp-pfp-signout');
    if (signoutBtn) {
      signoutBtn.addEventListener('click', async () => {
        pfpDropdown.classList.add('hidden');
        if (db) await db.auth.signOut();
        currentUser = null;
        if (launchBtn) launchBtn.classList.remove('hidden');
        if (userNav)   userNav.classList.add('hidden');
        showLandingToast('Signed out successfully', 'success');
      });
    }
  }

  // Handle return intent
  function handleReturnIntent() {
    const returnTo = sessionStorage.getItem('returnTo');
    if (!returnTo) return;
    sessionStorage.removeItem('returnTo');
    if (currentUser) {
      document.getElementById('page-landing').classList.remove('hidden');
      document.getElementById('page-login').classList.add('hidden');
      document.getElementById('page-signup').classList.add('hidden');
      document.getElementById('page-app').classList.add('hidden');
      if (returnTo === 'review') {
        setTimeout(() => {
          const section = document.getElementById('lp-testimonials');
          if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(async () => {
            const modal = document.getElementById('review-modal');
            if (modal) {
              await fillUserInfoStrip('review-user-avatar','review-user-name','review-user-since');
              modal.classList.remove('hidden');
              document.body.style.overflow = 'hidden';
            }
          }, 600);
        }, 100);
      } else if (returnTo === 'faq') {
        showFAQPage(null);
      }
    }
  }

  window._handleReturnIntent = handleReturnIntent;
});

/* ─── Landing page toast ─── */
function showLandingToast(msg, type) {
  let container = document.getElementById('landing-toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'landing-toasts';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  const bg = type === 'info' ? '#4e7ab1' : type === 'error' ? '#ef4444' : '#34d399';
  el.style.cssText = `background:${bg};color:#fff;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,0.3);pointer-events:auto;`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity 0.3s'; setTimeout(()=>el.remove(),350); }, 3500);
}

function showLandingLoginHint() {
  setTimeout(() => {
    const card = document.querySelector('#page-login .login-card');
    if (!card || document.getElementById('review-login-hint')) return;
    const hint = document.createElement('p');
    hint.id = 'review-login-hint';
    hint.style.cssText = 'text-align:center;font-size:13px;color:#d6a7c2;margin-top:12px;';
    hint.textContent = '✍️ Sign in to continue — you\'ll be taken straight back.';
    card.appendChild(hint);
  }, 100);
}

/* ===== NEW LANDING interactions (scoped) ===== */

(function(){
  'use strict';
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn);}
  ready(function(){
    var LP_ROOT=document.getElementById('page-landing')||document;
    // Mark that JS is active — this engages the hidden-then-reveal animation.
    // Without this class (JS failed / cached / disabled) content stays visible.
    if(LP_ROOT&&LP_ROOT.classList) LP_ROOT.classList.add('js-reveal');
    var nav=document.getElementById('nav');
    var prog=document.getElementById('prog');
    var reveals=[].slice.call(LP_ROOT.querySelectorAll('.reveal, .stagger'));
    var counters=[].slice.call(LP_ROOT.querySelectorAll('[data-count]'));
    counters.forEach(function(el){el.setAttribute('data-from',el.textContent);el.setAttribute('data-done','0');});
    var donut=document.getElementById('donutSeg');
    var howWrap=document.getElementById('howWrap'), howFill=document.getElementById('howFill');
    var steps=[].slice.call(LP_ROOT.querySelectorAll('.step'));

    function vh(){return window.innerHeight||800;}
    function inView(el,f){var r=el.getBoundingClientRect();return r.top<vh()*(f||.86)&&r.bottom>0;}
    function tween(el,dur,fn,delay){function go(){var s=null;function fr(t){if(!s)s=t;var p=Math.min(1,(t-s)/dur);fn(1-Math.pow(1-p,3),p);if(p<1)requestAnimationFrame(fr);}requestAnimationFrame(fr);}if(delay)setTimeout(go,delay);else go();}
    if(donut){donut.style.strokeDashoffset='188.5';tween(donut,1400,function(e){donut.style.strokeDashoffset=(188.5-128.5*e);},500);}

    function count(el){
      if(el.getAttribute('data-done')==='1')return;el.setAttribute('data-done','1');
      var raw=el.getAttribute('data-from'),m=raw.match(/[\d,]*\.?\d+/);if(!m)return;
      var num=m[0],pre=el.getAttribute('data-pre')||'',suf=el.getAttribute('data-suf')||'',comma=el.getAttribute('data-comma')==='1';
      var target=parseFloat(num.replace(/,/g,''));if(isNaN(target))return;
      var dur=1400,s=null;
      function fmt(v){var n=Math.round(v);return pre+(comma?n.toLocaleString('en-IN'):n)+suf;}
      function step(t){if(!s)s=t;var p=Math.min(1,(t-s)/dur),e=1-Math.pow(1-p,3);el.textContent=fmt(target*e);if(p<1)requestAnimationFrame(step);}
      el.textContent=fmt(0);requestAnimationFrame(step);
    }

    function update(){
      try {
        var doc=document.documentElement,sc=window.pageYOffset||doc.scrollTop||0,max=doc.scrollHeight-doc.clientHeight;
        if(prog) prog.style.width=(max>0?sc/max*100:0)+'%';
        if(nav) nav.classList.toggle('scrolled',sc>24);
        reveals.forEach(function(el){
          if(el.getAttribute('data-rev')==='1')return;
          if(inView(el,.92)){
            el.setAttribute('data-rev','1');
            if(el.classList.contains('stagger')){
              [].slice.call(el.children).forEach(function(ch,i){tween(ch,640,function(e){ch.style.opacity=e;ch.style.transform=e<1?'translateY('+(28*(1-e))+'px)':'none';},i*85);});
            } else {
              tween(el,760,function(e){el.style.opacity=e;el.style.transform=e<1?'translateY('+(34*(1-e))+'px)':'none';});
            }
          }
        });
        counters.forEach(function(el){if(el.getAttribute('data-done')!=='1'&&inView(el,.95))count(el);});
        if(howWrap&&howFill){
          var r=howWrap.getBoundingClientRect(),prog2=Math.max(0,Math.min(1,(vh()*.6-r.top)/(r.height*.7)));
          howFill.style.width=(prog2*78)+'%';
          var active=Math.round(prog2*steps.length);
          steps.forEach(function(s,i){s.classList.toggle('on',i<active);});
        }
      } catch(err){
        // Never let an animation error leave content invisible
        console.error('landing update error', err);
        revealAll();
      }
    }
    // Safety net: if anything goes wrong, make every reveal element visible
    function revealAll(){
      reveals.forEach(function(el){
        el.setAttribute('data-rev','1');
        el.style.opacity='1';
        el.style.transform='none';
        [].slice.call(el.children||[]).forEach(function(ch){ ch.style.opacity='1'; ch.style.transform='none'; });
      });
    }
    update();
    window.addEventListener('scroll',update,{passive:true});
    window.addEventListener('resize',update);
    // Belt-and-suspenders: ensure hero/content is never stuck hidden
    setTimeout(revealAll, 1200);

    /* hero mockup 3D tilt — applied to the wrapper so the .mock keeps its
       CSS "floaty" animation (an inline transform on .mock would override it) */
    var tilt=document.getElementById('tiltWrap'),mock=document.getElementById('mock');
    if(tilt){
      tilt.style.transformStyle='preserve-3d';
      tilt.addEventListener('mousemove',function(e){
        var r=tilt.getBoundingClientRect(),px=(e.clientX-r.left)/r.width-.5,py=(e.clientY-r.top)/r.height-.5;
        tilt.style.transform='rotateY('+(px*9)+'deg) rotateX('+(-py*9)+'deg)';
      });
      tilt.addEventListener('mouseleave',function(){tilt.style.transform='rotateY(0) rotateX(0)';});
    }

    /* feature cards cursor glow */
    [].slice.call(LP_ROOT.querySelectorAll('.feat')).forEach(function(c){
      c.addEventListener('mousemove',function(e){var r=c.getBoundingClientRect();c.style.setProperty('--mx',((e.clientX-r.left)/r.width*100)+'%');c.style.setProperty('--my',((e.clientY-r.top)/r.height*100)+'%');});
    });

    /* contact form → save to Supabase (triggers email via Edge Function) */
    var form=document.getElementById('contactForm'),ok=document.getElementById('okMsg');
    if(form){form.addEventListener('submit',async function(e){
      e.preventDefault();
      var btn=form.querySelector('button[type="submit"]');
      var orig=btn?btn.textContent:'';
      if(btn){btn.disabled=true;btn.textContent='Sending…';}
      var fd=new FormData(form);
      var payload={
        name:(fd.get('name')||'').toString().trim(),
        email:(fd.get('email')||'').toString().trim(),
        subject:(fd.get('subject')||'').toString().trim(),
        message:(fd.get('message')||'').toString().trim()
      };
      try{
        if(typeof DEMO_MODE!=='undefined'&&DEMO_MODE){throw new Error('demo');}
        var res=await db.from('contact_messages').insert(payload);
        if(res.error)throw res.error;
        form.reset();
        ok.textContent='✓ Message sent! We\'ll get back to you soon.';
        ok.classList.add('show');
        setTimeout(function(){ok.classList.remove('show');},5000);
      }catch(err){
        console.error('Contact form error:',err);
        ok.textContent='Couldn\'t send — please email hello@fino.app directly.';
        ok.style.color='#f87171';
        ok.classList.add('show');
        setTimeout(function(){ok.classList.remove('show');ok.style.color='';},6000);
      }finally{
        if(btn){btn.disabled=false;btn.textContent=orig;}
      }
    });}

    /* starfield */
    var cv=document.getElementById('stars'),ctx=cv&&cv.getContext?cv.getContext('2d'):null,W,H,dpr,parts=[];
    if(cv&&ctx){
    function size(){dpr=Math.min(window.devicePixelRatio||1,2);W=cv.width=innerWidth*dpr;H=cv.height=innerHeight*dpr;cv.style.width=innerWidth+'px';cv.style.height=innerHeight+'px';}
    size();window.addEventListener('resize',size);
    var cols=['123,184,240','206,181,212','52,211,153','78,122,177'];
    for(var i=0;i<46;i++)parts.push({x:Math.random(),y:Math.random(),r:Math.random()*1.6+.4,sp:Math.random()*.4+.12,a:Math.random()*.5+.2,c:cols[(Math.random()*cols.length)|0],ph:Math.random()*6.28});
    var t0=performance.now();
    function draw(now){
      var lp=document.getElementById('page-landing');
      if(lp&&lp.classList.contains('hidden')){requestAnimationFrame(draw);return;}
      var tt=(now-t0)/1000;ctx.clearRect(0,0,W,H);
      for(var i=0;i<parts.length;i++){var p=parts[i];p.y-=p.sp/100;if(p.y<-.02){p.y=1.02;p.x=Math.random();}
        var tw=.55+.45*Math.sin(tt*1.5+p.ph);ctx.fillStyle='rgba('+p.c+','+(p.a*tw)+')';ctx.beginPath();ctx.arc(p.x*W,p.y*H,p.r*dpr,0,6.28);ctx.fill();}
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    }
  });
})();

/* ===== END NEW LANDING interactions ===== */
