// =============================================================
// 每日打卡积分系统 - 主逻辑
// =============================================================

let _sb;
let currentUser = null;
let userProfile = null;
let isAdmin = false;
let selectedTasks = new Set();
let editingTaskId = null;

// ── 页面元素 ──
const $ = id => document.getElementById(id);
const authScreen = $('authScreen');
const appContainer = $('appContainer');
const loginForm = $('loginForm');
const registerForm = $('registerForm');
const authError = $('authError');

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', async () => {
  // 先绑定按钮事件（确保按钮可点，即使后端出问题也能看到错误提示）
  bindAuthEvents();

  try {
    _sb = initSupabase();

    // 检查是否已登录
    const { data: { session } } = await _sb.auth.getSession();
    if (session) {
      await loadApp(session);
    }

    // 监听认证状态变化
    _sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await loadApp(session);
      } else if (event === 'SIGNED_OUT') {
        showAuth();
      }
    });
  } catch (err) {
    console.error('Supabase 初始化失败:', err);
    showAuthError('连接服务器失败，请检查网络后刷新重试');
  }
});

// ── 认证事件绑定 ──
function bindAuthEvents() {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_sb) return showAuthError('正在连接服务器，请稍后再试');
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) return showAuthError('请输入邮箱和密码');

    const btn = loginForm.querySelector('.btn');
    btn.disabled = true; btn.textContent = '登录中...';

    const { error } = await _sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = '登录';
    if (error) return showAuthError(error.message);
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_sb) return showAuthError('正在连接服务器，请稍后再试');
    const name = $('regName').value.trim();
    const email = $('regEmail').value.trim();
    const password = $('regPassword').value;
    if (!name || !email || !password) return showAuthError('请填写所有字段');
    if (password.length < 6) return showAuthError('密码至少6位');

    const btn = registerForm.querySelector('.btn');
    btn.disabled = true; btn.textContent = '注册中...';

    const { error } = await _sb.auth.signUp({
      email, password,
      options: { data: { display_name: name } }
    });
    btn.disabled = false; btn.textContent = '注册';
    if (error) return showAuthError(error.message);

    showToast('注册成功！请查看邮箱确认，或直接登录', 'success');
    showLoginForm();
  });

  $('showRegister').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(); });
  $('showLogin').addEventListener('click', (e) => { e.preventDefault(); showLoginForm(); });
  $('logoutBtn').addEventListener('click', async () => {
    await _sb.auth.signOut();
    showAuth();
  });
}

// ── 加载应用 ──
async function loadApp(session) {
  currentUser = session.user;
  authScreen.style.display = 'none';
  appContainer.style.display = 'block';

  // 获取用户资料
  const { data: profile } = await _sb
    .from('user_profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();

  userProfile = profile;
  isAdmin = profile?.role === 'admin';

  $('userName').textContent = profile?.display_name || currentUser.email;
  $('userBadge').textContent = isAdmin ? '管理员' : '用户';

  setupTabs();
  await refreshAll();
}

// ── Tab 系统 ──
function setupTabs() {
  const tabNav = $('tabNav');
  const tabs = isAdmin ? [
    { id: 'tabApprovals', label: '📋 审批' },
    { id: 'tabTasks', label: '📝 任务管理' },
    { id: 'tabManual', label: '➕ 手动加分' },
  ] : [
    { id: 'tabCheckin', label: '✅ 今日打卡' },
    { id: 'tabHistory', label: '📊 积分' },
  ];

  tabNav.innerHTML = tabs.map((t, i) =>
    `<button class="${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  tabNav.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      tabNav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      $(btn.dataset.tab).classList.add('active');
    });
  });

  // 默认激活第一个 tab
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const firstTab = tabs[0].id;
  $(firstTab).classList.add('active');
}

// ── 刷新所有数据 ──
async function refreshAll() {
  if (isAdmin) {
    await loadPendingApprovals();
    await loadApprovalHistory();
    await loadTaskManagement();
    await loadUserPoints();
  } else {
    await loadCheckinPage();
    await loadHistory();
  }
}

// ════════════════════════════════════════════════
// 用户端功能
// ════════════════════════════════════════════════

// ── 加载今日打卡页 ──
async function loadCheckinPage() {
  $('checkinLoading').style.display = 'block';
  $('checkinContent').style.display = 'none';

  const today = new Date().toISOString().split('T')[0];
  $('checkinDateTitle').textContent = `📅 ${today} 任务`;

  // 查今天是否已有打卡记录
  const { data: existingCheckin } = await _sb
    .from('check_ins')
    .select('id, status')
    .eq('user_id', currentUser.id)
    .eq('date', today)
    .maybeSingle();

  selectedTasks.clear();
  $('alreadySubmitted').style.display = 'none';

  // 加载所有可用任务
  const { data: allTasks } = await _sb
    .from('tasks')
    .select('*')
    .eq('is_active', true)
    .order('id');

  if (!allTasks || allTasks.length === 0) {
    $('taskList').innerHTML = '<div class="empty-state"><p>暂无可用任务</p></div>';
    $('submitCheckinBtn').style.display = 'none';
    $('taskSummary').style.display = 'none';
    $('checkinLoading').style.display = 'none';
    $('checkinContent').style.display = 'block';
    return;
  }

  let submittedTaskIds = new Set();
  let submittedStatusMap = {};

  if (existingCheckin) {
    // 加载已提交的任务
    const { data: submittedTasks } = await _sb
      .from('check_in_tasks')
      .select('task_id, task_name, points, status')
      .eq('check_in_id', existingCheckin.id);

    if (submittedTasks) {
      submittedTasks.forEach(t => {
        submittedTaskIds.add(t.task_id);
        submittedStatusMap[t.task_id] = t.status;
      });
    }

    // 显示状态提示
    $('alreadySubmitted').style.display = 'block';
    const submittedCount = submittedTasks ? submittedTasks.length : 0;
    const statusMsg =
      existingCheckin.status === 'pending' ? `⏳ 已提交 ${submittedCount} 个任务，等待审批` :
      existingCheckin.status === 'approved' ? '✅ 今日已通过' : '❌ 今日已驳回';
    $('alreadySubmitted').querySelector('.status-message').textContent = statusMsg;
  }

  // 渲染任务列表：已提交的置灰 + 未提交的可选
  const list = $('taskList');
  list.innerHTML = (allTasks || []).map(t => {
    const subStatus = submittedStatusMap[t.id];
    if (subStatus) {
      const icon = subStatus === 'approved' ? '✅' : subStatus === 'rejected' ? '❌' : '⏳';
      const label = subStatus === 'approved' ? '已通过' : subStatus === 'rejected' ? '已驳回' : '待审批';
      if (subStatus === 'rejected') {
        // 驳回的任务：显示为普通可选任务，右上角加驳回标签
        return `<li class="task-item" data-task-id="${t.id}" data-points="${t.points}" data-name="${t.name}">
          <div class="task-checkbox"></div>
          <span class="task-name">${t.name}</span>
          <span class="task-points">+${t.points}</span>
          <span class="task-status-label status-rejected">❌ 已驳回</span>
        </li>`;
      } else {
        // 已通过/待审批：置灰不可操作
        return `<li class="task-item checked disabled" data-task-id="${t.id}" data-points="${t.points}" data-name="${t.name}">
          <div class="task-checkbox"></div>
          <span class="task-name">${t.name}</span>
          <span class="task-points">+${t.points}</span>
          <span class="task-status-label status-${subStatus}">${icon} ${label}</span>
        </li>`;
      }
    } else {
      return `<li class="task-item" data-task-id="${t.id}" data-points="${t.points}" data-name="${t.name}">
        <div class="task-checkbox"></div>
        <span class="task-name">${t.name}</span>
        <span class="task-points">+${t.points}</span>
      </li>`;
    }
  }).join('');

  // 仅为未提交的任务绑定点击事件
  list.querySelectorAll('.task-item:not(.disabled)').forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('checked');
      const id = item.dataset.taskId;
      if (item.classList.contains('checked')) {
        selectedTasks.add(id);
      } else {
        selectedTasks.delete(id);
      }
      updateCheckinSummary();
    });
  });

  updateCheckinSummary();

  $('checkinLoading').style.display = 'none';
  $('checkinContent').style.display = 'block';

  // 刷新积分横幅
  await refreshStreakBanner();

  // 补签卡日期输入框默认设为昨天
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  $('makeupDateInput').value = yesterday.toISOString().split('T')[0];

  // 本周记录
  await loadThisWeek();
}

// ── 加载可选任务列表 ──
async function loadAvailableTasks() {
  $('checkinLoading').style.display = 'none';
  $('checkinContent').style.display = 'block';
  $('alreadySubmitted').style.display = 'none';
  selectedTasks.clear();

  const { data: tasks } = await _sb
    .from('tasks')
    .select('*')
    .eq('is_active', true)
    .order('id');

  const list = $('taskList');
  if (!tasks || tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>暂无可用任务</p></div>';
    $('submitCheckinBtn').style.display = 'none';
    $('taskSummary').style.display = 'none';
    return;
  }

  list.innerHTML = tasks.map(t => `
    <li class="task-item" data-task-id="${t.id}" data-points="${t.points}" data-name="${t.name}">
      <div class="task-checkbox"></div>
      <span class="task-name">${t.name}</span>
      <span class="task-points">+${t.points}</span>
    </li>
  `).join('');

  list.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('checked');
      const id = item.dataset.taskId;
      if (item.classList.contains('checked')) {
        selectedTasks.add(id);
      } else {
        selectedTasks.delete(id);
      }
      updateCheckinSummary();
    });
  });

  updateCheckinSummary();
}

function updateCheckinSummary() {
  const count = selectedTasks.size;
  let totalPoints = 0;
  document.querySelectorAll('.task-item.checked').forEach(item => {
    totalPoints += parseInt(item.dataset.points);
  });
  $('selectedCount').textContent = count;
  $('selectedPoints').textContent = totalPoints;
  $('taskSummary').style.display = count > 0 ? 'flex' : 'none';
  $('submitCheckinBtn').style.display = count > 0 ? 'block' : 'none';
}

// ── 提交打卡（支持分批提交） ──
$('submitCheckinBtn').addEventListener('click', async () => {
  if (selectedTasks.size === 0) return;
  const btn = $('submitCheckinBtn');
  btn.disabled = true; btn.textContent = '提交中...';

  const today = new Date().toISOString().split('T')[0];

  // 检查今天是否已有打卡记录
  const { data: existing } = await _sb
    .from('check_ins')
    .select('id')
    .eq('user_id', currentUser.id)
    .eq('date', today)
    .maybeSingle();

  let checkinId;
  if (existing) {
    checkinId = existing.id;
    // 如果之前是驳回状态，重新标记为待审批
    await _sb.from('check_ins').update({ status: 'pending' }).eq('id', checkinId);
  } else {
    // 新建打卡记录
    const { data: checkin, error: ciErr } = await _sb
      .from('check_ins')
      .insert({ user_id: currentUser.id, date: today })
      .select()
      .single();
    if (ciErr) { showToast('提交失败: ' + ciErr.message, 'error'); btn.disabled = false; btn.textContent = '提交审批'; return; }
    checkinId = checkin.id;
  }

  // 获取已提交的任务 ID，避免重复提交
  const { data: existingTasks } = await _sb
    .from('check_in_tasks')
    .select('task_id')
    .eq('check_in_id', checkinId);
  const alreadySubmitted = new Set((existingTasks || []).map(t => t.task_id));

  // 只插入未提交过的任务
  const tasksToInsert = [];
  selectedTasks.forEach(taskId => {
    if (!alreadySubmitted.has(parseInt(taskId))) {
      const item = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
      if (item) {
        tasksToInsert.push({
          check_in_id: checkinId,
          task_id: parseInt(taskId),
          task_name: item.dataset.name,
          points: parseInt(item.dataset.points)
        });
      }
    }
  });

  if (tasksToInsert.length === 0) {
    showToast('这些任务已经提交过了', 'info');
    btn.disabled = false; btn.textContent = '提交审批';
    return;
  }

  const { error: ctErr } = await _sb
    .from('check_in_tasks')
    .insert(tasksToInsert);

  if (ctErr) {
    showToast('提交失败: ' + ctErr.message, 'error');
  } else {
    showToast(`已提交 ${tasksToInsert.length} 个任务 ✅`, 'success');
    await loadCheckinPage();
  }

  btn.disabled = false; btn.textContent = '提交审批';
});

// ── 本周记录 ──
async function loadThisWeek() {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + 1);
  const startStr = startOfWeek.toISOString().split('T')[0];
  const endStr = today.toISOString().split('T')[0];

  const { data: checkins } = await _sb
    .from('check_ins')
    .select('*')
    .eq('user_id', currentUser.id)
    .gte('date', startStr)
    .lte('date', endStr)
    .order('date', { ascending: false });

  const container = $('thisWeekList');
  if (!checkins || checkins.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>本周暂无打卡记录</p></div>';
    return;
  }

  container.innerHTML = checkins.map(c => `
    <div class="history-item">
      <div class="history-left">
        <span class="history-date">${c.date}</span>
        <span class="history-reason">${statusLabel(c.status)}</span>
      </div>
      <span class="status-badge status-${c.status}">${statusLabel(c.status)}</span>
    </div>
  `).join('');
}

function statusLabel(s) {
  return s === 'pending' ? '待审批' : s === 'approved' ? '已通过' : '已驳回';
}

// ── 用户积分历史 ──
async function loadHistory() {
  // 刷新积分横幅
  await refreshStreakBanner();

  // 统计
  const { data: checkins } = await _sb
    .from('check_ins')
    .select('*')
    .eq('user_id', currentUser.id);

  const approved = (checkins || []).filter(c => c.status === 'approved').length;
  const pending = (checkins || []).filter(c => c.status === 'pending').length;

  $('totalPointsDisplay').textContent = userProfile?.total_points || 0;
  $('streakDaysDisplay') && ($('streakDaysDisplay').textContent = userProfile?.streak_days || 0);
  $('approvedCount').textContent = approved;
  $('pendingCount').textContent = pending;

  // 积分日志
  const { data: logs } = await _sb
    .from('points_log')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(50);

  const container = $('historyList');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无记录</p></div>';
    return;
  }

  container.innerHTML = logs.map(l => {
    const isPositive = l.points > 0;
    const pointsClass = isPositive ? 'positive' : 'negative';
    const pointsSign = isPositive ? '+' : '';
    return `
    <div class="history-item">
      <div class="history-left">
        <span class="history-date">${formatTime(l.created_at)}</span>
        <span class="history-reason">${l.reason}</span>
      </div>
      <span class="history-points ${pointsClass}">${pointsSign}${l.points}</span>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════
// 管理员功能
// ════════════════════════════════════════════════

// ── 待审批列表（逐项审批） ──
async function loadPendingApprovals() {
  const { data: pending } = await _sb
    .from('check_ins')
    .select('id, user_id, date, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  const container = $('pendingApprovalsList');

  if (!pending || pending.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>🎉 暂无待审批</p></div>';
    return;
  }

  // 获取用户名称
  const userIds = [...new Set(pending.map(p => p.user_id))];
  const { data: profiles } = await _sb
    .from('user_profiles')
    .select('id, display_name')
    .in('id', userIds);

  const nameMap = {};
  (profiles || []).forEach(p => nameMap[p.id] = p.display_name);

  let html = '';
  for (const p of pending) {
    const { data: tasks } = await _sb
      .from('check_in_tasks')
      .select('id, task_name, points')
      .eq('check_in_id', p.id);

    const totalPoints = (tasks || []).reduce((s, t) => s + t.points, 0);

    html += `
      <div class="approval-item" data-checkin-id="${p.id}">
        <div class="approval-header">
          <span class="approval-user">${nameMap[p.user_id] || '用户'}</span>
          <span class="approval-date">${p.date}</span>
        </div>
        <div class="approval-tasks approval-tasks-checkable">
          ${(tasks || []).map(t => `
            <label class="task-approve-row">
              <input type="checkbox" class="task-approve-cb" data-task-id="${t.id}" checked>
              <span class="task-approve-name">${t.task_name}</span>
              <span class="task-points">+${t.points}</span>
            </label>
          `).join('')}
        </div>
        <div class="approval-total">合计：+${totalPoints} 分</div>
        <div class="approval-actions">
          <button class="btn btn-primary btn-sm" onclick="handlePerTaskApproval(${p.id}, false)">✓ 通过选中任务</button>
          <button class="btn btn-outline btn-sm" onclick="handlePerTaskApproval(${p.id}, true)">✗ 全部驳回</button>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

// ── 逐项审批操作 ──
async function handlePerTaskApproval(checkinId, rejectAll) {
  const card = document.querySelector(`.approval-item[data-checkin-id="${checkinId}"]`);
  
  if (rejectAll) {
    // 全部驳回 = 传空数组
    const { error } = await _sb.rpc('approve_check_in_tasks', {
      p_check_in_id: checkinId,
      p_reviewer_id: currentUser.id,
      p_task_ids: []
    });
    if (error) {
      showToast('操作失败: ' + error.message, 'error');
    } else {
      showToast('已全部驳回', 'success');
      await loadPendingApprovals();
      await loadApprovalHistory();
    }
    return;
  }

  // 收集选中的任务 ID
  const selected = [];
  if (card) {
    card.querySelectorAll('.task-approve-cb:checked').forEach(cb => {
      selected.push(parseInt(cb.dataset.taskId));
    });
  }

  if (selected.length === 0) {
    showToast('请至少选择一个任务', 'error');
    return;
  }

  const { error } = await _sb.rpc('approve_check_in_tasks', {
    p_check_in_id: checkinId,
    p_reviewer_id: currentUser.id,
    p_task_ids: selected
  });

  if (error) {
    showToast('操作失败: ' + error.message, 'error');
  } else {
    showToast(`已通过 ${selected.length} 个任务 ✅`, 'success');
    await loadPendingApprovals();
    await loadApprovalHistory();
  }
}

// ── 审批记录 ──
async function loadApprovalHistory() {
  const { data: history } = await _sb
    .from('check_ins')
    .select('id, user_id, date, status, reviewed_at')
    .neq('status', 'pending')
    .order('reviewed_at', { ascending: false })
    .limit(20);

  const container = $('approvalHistoryList');

  if (!history || history.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无审批记录</p></div>';
    return;
  }

  const userIds = [...new Set(history.map(h => h.user_id))];
  const { data: profiles } = await _sb
    .from('user_profiles')
    .select('id, display_name')
    .in('id', userIds);

  const nameMap = {};
  (profiles || []).forEach(p => nameMap[p.id] = p.display_name);

  container.innerHTML = history.map(h => `
    <div class="history-item">
      <div class="history-left">
        <span class="history-date">${h.date}</span>
        <span class="history-reason">${nameMap[h.user_id] || '用户'}</span>
      </div>
      <span class="status-badge status-${h.status}">${statusLabel(h.status)}</span>
    </div>
  `).join('');
}

// ── 任务管理 ──
async function loadTaskManagement() {
  const { data: tasks } = await _sb
    .from('tasks')
    .select('*')
    .order('id');

  const container = $('taskManageList');
  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无任务</p></div>';
    return;
  }

  container.innerHTML = tasks.map(t => `
    <div class="admin-task-item">
      <div class="admin-task-left">
        <span class="admin-task-name">${t.name}</span>
        <span class="admin-task-points">+${t.points} 分</span>
      </div>
      <div class="admin-task-actions">
        <button class="btn btn-outline btn-sm" onclick="editTask(${t.id}, '${t.name}', ${t.points})">编辑</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${t.id})">删除</button>
      </div>
    </div>
  `).join('');
}

// ── 添加任务 ──
$('addTaskBtn').addEventListener('click', () => {
  editingTaskId = null;
  $('taskModalTitle').textContent = '添加任务';
  $('taskModalName').value = '';
  $('taskModalPoints').value = '';
  $('taskModal').classList.add('open');
});

function editTask(id, name, points) {
  editingTaskId = id;
  $('taskModalTitle').textContent = '编辑任务';
  $('taskModalName').value = name;
  $('taskModalPoints').value = points;
  $('taskModal').classList.add('open');
}

$('taskModalConfirm').addEventListener('click', async () => {
  const name = $('taskModalName').value.trim();
  const points = parseInt($('taskModalPoints').value);
  if (!name || !points) { showToast('请填写完整', 'error'); return; }

  if (editingTaskId) {
    const { error } = await _sb
      .from('tasks')
      .update({ name, points })
      .eq('id', editingTaskId);
    if (error) { showToast('更新失败', 'error'); return; }
    showToast('已更新 ✅', 'success');
  } else {
    const { error } = await _sb
      .from('tasks')
      .insert({ name, points });
    if (error) { showToast('添加失败', 'error'); return; }
    showToast('已添加 ✅', 'success');
  }

  $('taskModal').classList.remove('open');
  await loadTaskManagement();
});

$('taskModalCancel').addEventListener('click', () => {
  $('taskModal').classList.remove('open');
});

// ── 删除任务 ──
async function deleteTask(id) {
  if (!confirm('确定要删除这个任务吗？')) return;
  const { error } = await _sb.from('tasks').delete().eq('id', id);
  if (error) { showToast('删除失败', 'error'); return; }
  showToast('已删除', 'success');
  await loadTaskManagement();
}

// ── 用户积分总览（管理员手动加分） ──
async function loadUserPoints() {
  const { data: users } = await _sb
    .from('user_profiles')
    .select('*')
    .neq('role', 'admin')  // 不显示管理员自己
    .order('total_points', { ascending: false });

  const container = $('userPointsList');
  if (!users || users.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无用户</p></div>';
    return;
  }

  container.innerHTML = users.map(u => `
    <div class="user-points-item">
      <div class="user-points-left">
        <span class="user-points-name">${u.display_name}</span>
        <span class="user-points-total">${u.total_points} 分</span>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openPointsModal('${u.id}')">+ 加分</button>
    </div>
  `).join('');
}

// ── 手动加分弹窗 ──
async function openPointsModal(userId) {
  // 加载用户列表
  const { data: users } = await _sb
    .from('user_profiles')
    .select('*')
    .neq('role', 'admin');

  const userSelect = $('pointsModalUser');
  userSelect.innerHTML = (users || []).map(u =>
    `<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>${u.display_name}</option>`
  ).join('');

  // 加载任务列表（供选择）
  const { data: tasks } = await _sb
    .from('tasks')
    .select('*')
    .eq('is_active', true);

  const taskSelect = $('pointsModalTask');
  taskSelect.innerHTML = '<option value="">自定义输入</option>' +
    (tasks || []).map(t =>
      `<option value="${t.id}" data-points="${t.points}" data-name="${t.name}">${t.name} (+${t.points})</option>`
    ).join('');

  // 选择任务时自动填写
  taskSelect.onchange = () => {
    const opt = taskSelect.options[taskSelect.selectedIndex];
    if (opt.value) {
      $('pointsModalReason').value = opt.dataset.name;
      $('pointsModalValue').value = opt.dataset.points;
    } else {
      $('pointsModalReason').value = '';
      $('pointsModalValue').value = '';
    }
  };

  $('pointsModalReason').value = '';
  $('pointsModalValue').value = '';
  $('pointsModal').classList.add('open');
}

$('pointsModalConfirm').addEventListener('click', async () => {
  const userId = $('pointsModalUser').value;
  const reason = $('pointsModalReason').value.trim();
  const points = parseInt($('pointsModalValue').value);

  if (!userId || !reason || !points) {
    showToast('请填写完整信息', 'error');
    return;
  }

  const btn = $('pointsModalConfirm');
  btn.disabled = true; btn.textContent = '加分中...';

  const { error } = await _sb.rpc('admin_add_points', {
    p_user_id: userId,
    p_points: points,
    p_reason: reason
  });

  btn.disabled = false; btn.textContent = '确认加分';

  if (error) {
    showToast('加分失败: ' + error.message, 'error');
  } else {
    showToast(`已为 ${$('pointsModalUser').options[$('pointsModalUser').selectedIndex].text} +${points} 分 ✅`, 'success');
    $('pointsModal').classList.remove('open');
    await loadUserPoints();
  }
});

$('pointsModalCancel').addEventListener('click', () => {
  $('pointsModal').classList.remove('open');
});

// ════════════════════════════════════════════════
// 通用工具函数
// ════════════════════════════════════════════════

function showAuth() {
  currentUser = null;
  userProfile = null;
  isAdmin = false;
  authScreen.style.display = 'flex';
  appContainer.style.display = 'none';
  showLoginForm();
}

function showLoginForm() {
  loginForm.style.display = 'block';
  registerForm.style.display = 'none';
  authError.style.display = 'none';
}

function showRegisterForm() {
  loginForm.style.display = 'none';
  registerForm.style.display = 'block';
  authError.style.display = 'none';
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.style.display = 'block';
}

function showToast(msg, type = 'success') {
  const container = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 刷新积分横幅 ──
async function refreshStreakBanner() {
  // 重新读取用户最新资料
  const { data: profile } = await _sb
    .from('user_profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();
  if (profile) {
    userProfile = profile;
    const pts = profile.total_points || 0;
    const streak = profile.streak_days || 0;
    $('bannerTotalPoints').textContent = pts;
    $('bannerStreakDays').textContent = streak;
    $('bannerStreakBonus').textContent = '+0';
    if (streak >= 31) $('bannerStreakBonus').textContent = '+5';
    else if (streak >= 16) $('bannerStreakBonus').textContent = '+3';
    else if (streak >= 8) $('bannerStreakBonus').textContent = '+2';
    else if (streak >= 2) $('bannerStreakBonus').textContent = '+1';
  }
}

// ── 使用补签卡 ──
$('useMakeupBtn').addEventListener('click', async () => {
  const targetDate = $('makeupDateInput').value;
  if (!targetDate) {
    showToast('请选择要补签的日期', 'error');
    return;
  }

  const btn = $('useMakeupBtn');
  const resultDiv = $('makeupResult');
  btn.disabled = true;
  btn.textContent = '处理中...';
  resultDiv.style.display = 'none';

  const { data, error } = await _sb.rpc('use_makeup_card', {
    p_user_id: currentUser.id,
    p_target_date: targetDate
  });

  btn.disabled = false;
  btn.textContent = '使用补签卡 (10分)';

  if (error) {
    resultDiv.className = 'makeup-result error';
    resultDiv.textContent = '操作失败: ' + error.message;
    resultDiv.style.display = 'block';
    return;
  }

  if (data === 'ok') {
    resultDiv.className = 'makeup-result success';
    resultDiv.textContent = `✅ 补签 ${targetDate} 成功！已消耗 10 积分。`;
    resultDiv.style.display = 'block';
    showToast('补签成功 ✅', 'success');
    // 刷新横幅和本周记录
    await refreshStreakBanner();
    await loadThisWeek();
  } else {
    resultDiv.className = 'makeup-result error';
    resultDiv.textContent = data || '补签失败';
    resultDiv.style.display = 'block';
  }
});

// 暴露给 HTML 内联 onclick
window.handlePerTaskApproval = handlePerTaskApproval;
window.editTask = editTask;
window.deleteTask = deleteTask;
window.openPointsModal = openPointsModal;
