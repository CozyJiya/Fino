/* ============================================================
   app.js — Expense Tracker (Figma Design Match)
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

const SPEND_CATEGORIES = ['Food and drinks', 'Transport', 'Shopping', 'Groceries', 'Home', 'Entertainment', 'Event', 'Travel', 'Medical', 'Personal', 'Fitness', 'Services', 'Bills'];
const RECEIVED_CATEGORIES = ['Earning', 'Pocket money', 'Gift', 'Borrowed', 'Refund', 'Return', 'Interest', 'Cashback'];
const PALETTE    = ['#ceb5d4','#4e7ab1','#a98dc0','#7d9fc0','#d4a0e0','#6b8fb5','#b5a8d4','#8fa8c0','#c0a8d4','#a8b5d4','#d4b5c0','#b5c0d4','#c0d4b5'];

/* ── Helpers ── */
const $  = id => document.getElementById(id);
const fmt = n  => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toISOString().slice(0, 10);

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
    // Demo mode - skip to login screen
    showLogin();
    return;
  }
  
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    currentUser = session.user;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  $('page-login').classList.remove('hidden');
  $('page-signup').classList.add('hidden');
  $('page-app').classList.add('hidden');
}

function showSignup() {
  $('page-login').classList.add('hidden');
  $('page-signup').classList.remove('hidden');
  $('page-app').classList.add('hidden');
}

async function showApp() {
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
  await Promise.all([loadCategories(), loadExpenses()]);
  loadProfile();
  
  // Check and add monthly income automatically
  await checkAndAddMonthlyIncome();
  
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
  const email = username.includes('@') ? username : `${username}@expensetracker.local`;
  const { error } = await db.auth.signInWithPassword({ email, password });

  btn.disabled = false; btn.textContent = 'Sign In';
  if (error) { toast(error.message, 'error'); return; }
  const { data: { session } } = await db.auth.getSession();
  currentUser = session.user;
  showApp();
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
  const { error } = await db.auth.signUp({ email, password });
  btn.disabled = false; btn.textContent = 'Create Account';
  if (error) { toast(error.message, 'error'); return; }
  toast('Account created! Please sign in.');
  showLogin();
}

async function signOut() {
  if (DEMO_MODE) {
    currentUser = null;
    allExpenses = [];
    localStorage.removeItem(`exp_${currentUser?.id}`);
    showLogin();
    return;
  }
  
  await db.auth.signOut();
  currentUser = null;
  allExpenses = [];
  showLogin();
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
        ${e.description ? `<div class="expense-meta" style="margin-top:2px;font-size:12px;opacity:0.7">${e.description}</div>` : ''}
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
    });

    btn.disabled = false;
    
    if (error) { 
      console.error('Supabase error:', error);
      toast('Failed to add expense: ' + error.message, 'error'); 
      btn.textContent = 'Add Expense';
      return; 
    }

    toast('Expense added!');
    closeAddExpenseModal();
    cancelEdit();
    await loadExpenses();
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
  const days = 180;
  const labels = [];
  const data = [];
  
  // Calculate cumulative balance for last 180 days
  let runningBalance = 0;
  
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    
    // Get transactions for this day
    const dayTransactions = allExpenses.filter(e => e.date === dateStr);
    
    // Calculate day's net change (received - spent)
    dayTransactions.forEach(t => {
      const cat = allCategories.find(c => c.id === t.category_id);
      const amount = parseFloat(t.amount);
      if (cat && cat.type === 'received') {
        runningBalance += amount; // Add received money
      } else {
        runningBalance -= amount; // Subtract spent money
      }
    });
    
    labels.push(dateStr);
    data.push(runningBalance);
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
      options: { responsive: true, cutout: '62%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }
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

function savePfp() {
  if (!pendingPfpDataUrl) return;
  const key = `pfp_${currentUser?.id}`;
  localStorage.setItem(key, pendingPfpDataUrl);
  if (userProfile) userProfile.pfp_url = pendingPfpDataUrl;
  pendingPfpDataUrl = null;
  $('pfp-actions').style.display = 'none';
  toast('Profile photo saved!');
}

function removePfp() {
  pendingPfpDataUrl = null;
  localStorage.removeItem(`pfp_${currentUser?.id}`);
  if (userProfile) userProfile.pfp_url = null;
  updatePfpDisplay(null);
  $('pfp-actions').style.display = 'none';
  $('pfp-file-input').value = '';
  toast('Profile photo removed');
}

function loadPfp() {
  const stored = localStorage.getItem(`pfp_${currentUser?.id}`) || userProfile?.pfp_url || null;
  updatePfpDisplay(stored);
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
  if (!data) return;
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
      <td style="color:var(--text-muted)">${e.description || '—'}</td>
    </tr>
  `).join('');
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
  
  userProfile.username = newUsername;
  
  if (DEMO_MODE) {
    localStorage.setItem(`profile_${currentUser?.id}`, JSON.stringify(userProfile));
    $('a-username').value = newUsername;
    toast('Username updated successfully!');
    return;
  }
  
  const { error } = await db.from('profiles')
    .update({ username: newUsername, updated_at: new Date().toISOString() })
    .eq('id', currentUser.id);
  
  if (error) {
    toast('Failed to update username', 'error');
    return;
  }
  
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
  
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 15;
  let yPos = margin;
  
  // Helper function to add new page if needed
  const checkPageBreak = (requiredSpace) => {
    if (yPos + requiredSpace > pageHeight - margin) {
      pdf.addPage();
      yPos = margin;
      return true;
    }
    return false;
  };
  
  // Header
  pdf.setFillColor(13, 31, 60);
  pdf.rect(0, 0, pageWidth, 40, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(24);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Expense Tracker Report', margin, 20);
  
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  const reportDate = new Date().toLocaleDateString('en-IN', { 
    year: 'numeric', month: 'long', day: 'numeric' 
  });
  pdf.text(`Generated on: ${reportDate}`, margin, 30);
  
  yPos = 50;
  
  // User Info
  pdf.setTextColor(0, 0, 0);
  pdf.setFontSize(12);
  pdf.setFont('helvetica', 'bold');
  pdf.text('User Information', margin, yPos);
  yPos += 8;
  
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  if (userProfile) {
    const fullName = [userProfile.first_name, userProfile.middle_name, userProfile.surname]
      .filter(Boolean).join(' ');
    pdf.text(`Name: ${fullName || 'N/A'}`, margin, yPos);
    yPos += 6;
    pdf.text(`Email: ${currentUser?.email || 'N/A'}`, margin, yPos);
    yPos += 6;
    pdf.text(`Monthly Income: ${fmt(userIncome)}`, margin, yPos);
    yPos += 10;
  }
  
  // Summary Statistics
  checkPageBreak(40);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Summary Statistics', margin, yPos);
  yPos += 8;
  
  const total = allExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const now = new Date();
  const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const moExp = allExpenses.filter(e => e.date.startsWith(mo));
  const moTotal = moExp.reduce((s, e) => s + parseFloat(e.amount), 0);
  const days = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const daily = days ? moTotal / days : 0;
  
  pdf.setFillColor(240, 240, 245);
  pdf.rect(margin, yPos, pageWidth - 2*margin, 30, 'F');
  
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Total Expenses: ${fmt(total)}`, margin + 5, yPos + 8);
  pdf.text(`Monthly Spend: ${fmt(moTotal)}`, margin + 5, yPos + 16);
  pdf.text(`Daily Average: ${fmt(daily)}`, margin + 5, yPos + 24);
  yPos += 40;
  
  // Category Breakdown
  checkPageBreak(60);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Category Breakdown (This Month)', margin, yPos);
  yPos += 8;
  
  const byCat = {};
  moExp.forEach(e => {
    const name = e.categories?.name || getCatName(e.category_id) || 'Other';
    byCat[name] = (byCat[name] || 0) + parseFloat(e.amount);
  });
  
  const categories = Object.keys(byCat);
  if (categories.length > 0) {
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    
    categories.forEach((cat, i) => {
      checkPageBreak(8);
      const amount = byCat[cat];
      const percentage = moTotal > 0 ? ((amount / moTotal) * 100).toFixed(1) : 0;
      
      // Category bar
      const barWidth = (amount / moTotal) * (pageWidth - 2*margin - 60);
      pdf.setFillColor(206, 181, 212);
      pdf.rect(margin, yPos - 4, barWidth, 6, 'F');
      
      pdf.text(cat, margin, yPos);
      pdf.text(`${fmt(amount)} (${percentage}%)`, pageWidth - margin - 50, yPos, { align: 'right' });
      yPos += 8;
    });
  } else {
    pdf.setFontSize(10);
    pdf.text('No expenses for this month', margin, yPos);
    yPos += 8;
  }
  yPos += 5;
  
  // Monthly Summary Table
  checkPageBreak(80);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Monthly Summary', margin, yPos);
  yPos += 10;
  
  const monthly = {};
  allExpenses.forEach(e => {
    const m = e.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { received: 0, spent: 0, count: 0 };
    const cat = allCategories.find(c => c.id === e.category_id);
    const isReceived = cat ? cat.type === 'received' : false;
    const amount = parseFloat(e.amount);
    if (isReceived) monthly[m].received += amount;
    else monthly[m].spent += amount;
    monthly[m].count++;
  });
  
  const months = Object.keys(monthly).sort().reverse().slice(0, 12); // Last 12 months
  
  if (months.length > 0) {
    // Table header
    pdf.setFillColor(45, 90, 123);
    pdf.setTextColor(255, 255, 255);
    pdf.rect(margin, yPos, pageWidth - 2*margin, 8, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    
    const colWidth = (pageWidth - 2*margin) / 5;
    pdf.text('Month', margin + 2, yPos + 5);
    pdf.text('Received', margin + colWidth + 2, yPos + 5);
    pdf.text('Spent', margin + 2*colWidth + 2, yPos + 5);
    pdf.text('Net Balance', margin + 3*colWidth + 2, yPos + 5);
    pdf.text('Savings %', margin + 4*colWidth + 2, yPos + 5);
    yPos += 8;
    
    // Table rows
    pdf.setTextColor(0, 0, 0);
    pdf.setFont('helvetica', 'normal');
    
    months.forEach((m, i) => {
      checkPageBreak(8);
      
      const { received, spent } = monthly[m];
      const net = received - spent;
      const sr = received > 0 ? ((net / received) * 100).toFixed(1) + '%' : 'N/A';
      const label = new Date(m + '-01').toLocaleDateString('en-IN', { 
        month: 'short', year: 'numeric' 
      });
      
      // Alternate row colors
      if (i % 2 === 0) {
        pdf.setFillColor(245, 245, 250);
        pdf.rect(margin, yPos - 5, pageWidth - 2*margin, 7, 'F');
      }
      
      pdf.setTextColor(0, 0, 0);
      pdf.text(label, margin + 2, yPos);
      pdf.setTextColor(52, 211, 153);
      pdf.text(fmt(received), margin + colWidth + 2, yPos);
      pdf.setTextColor(239, 68, 68);
      pdf.text(fmt(spent), margin + 2*colWidth + 2, yPos);
      
      // Color code net balance
      pdf.setTextColor(net >= 0 ? 52 : 239, net >= 0 ? 211 : 68, net >= 0 ? 153 : 68);
      pdf.text(fmt(net), margin + 3*colWidth + 2, yPos);
      pdf.setTextColor(0, 0, 0);
      pdf.text(sr, margin + 4*colWidth + 2, yPos);
      
      yPos += 7;
    });
  } else {
    pdf.setFontSize(10);
    pdf.text('No expense data available', margin, yPos);
  }
  
  yPos += 10;
  
  // Recent Transactions
  checkPageBreak(60);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Recent Transactions (Last 10)', margin, yPos);
  yPos += 10;
  
  const recentExpenses = allExpenses.slice(0, 10);
  
  if (recentExpenses.length > 0) {
    pdf.setFontSize(9);
    
    recentExpenses.forEach((e, i) => {
      checkPageBreak(12);
      
      const catName = e.categories?.name || getCatName(e.category_id) || '—';
      const dateFormatted = formatDate(e.date);
      
      pdf.setFont('helvetica', 'bold');
      pdf.text(fmt(e.amount), margin, yPos);
      
      pdf.setFont('helvetica', 'normal');
      pdf.text(`${catName} • ${dateFormatted}`, margin + 35, yPos);
      
      if (e.description) {
        pdf.setFontSize(8);
        pdf.setTextColor(100, 100, 100);
        pdf.text(e.description.substring(0, 60), margin + 5, yPos + 4);
        pdf.setTextColor(0, 0, 0);
        pdf.setFontSize(9);
        yPos += 4;
      }
      
      yPos += 8;
    });
  } else {
    pdf.setFontSize(10);
    pdf.text('No transactions yet', margin, yPos);
  }
  
  // Footer on last page
  pdf.setFontSize(8);
  pdf.setTextColor(150, 150, 150);
  pdf.text('Generated by Expense Tracker', pageWidth / 2, pageHeight - 10, { align: 'center' });
  
  // Save PDF
  const fileName = `expense-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  pdf.save(fileName);
  
  toast('PDF report downloaded!');
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
    await db.from('expenses').delete().eq('user_id', currentUser.id);
    await db.from('profiles').delete().eq('id', currentUser.id);
    try { await db.rpc('delete_user'); } catch (_) {}
    await db.auth.signOut();
    currentUser = null;
    allExpenses = [];
    closeDeleteAccountModal();
    toast('Account deleted. Goodbye!');
    showLogin();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Delete My Account';
    toast('Failed to delete account', 'error');
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
