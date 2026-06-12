/**
 * 骰子扰动 (Dice Query Perturbation) v1.6.0
 *
 * 原理：拦截向量检索请求（/api/vector/query 与 /api/vector/query-multi 等），
 * 在 searchText 前注入随机抽取的意象短句（重复 N 次以保证剂量），
 * 使查询向量发生语义偏移，从而打散 top-k 命中结果。
 *
 * v1.6 变更：每个卡池一个独立折叠编辑框（池名即标题，好找好改）；
 * 原单一大文本框降级为「全库总览（高级）」；空卡池/空类目可保留。
 */

const MODULE = 'dice_perturbation';
const LOG_TAG = '[骰子扰动]';

const defaultSettings = {
    enabled: true,        // 总开关
    repeat: 3,            // 剂量：roll 结果重复拼接次数（1-10）
    categoryFirst: true,  // 先随机选类目、再随机选条目
    logRoll: true,        // 在 F12 控制台打印每次 roll 结果
    toastRoll: false,     // 每次 roll 弹通知（手机端验证用）
    excludePrefixes: 'file_',  // 排除前缀（逗号分隔）
    whitelist: '',        // 白名单（逗号分隔）
    diceText: '',         // 骰子库正文（全库文本，单一事实来源）
    activePools: [],      // 启用的卡池名（空数组 = 全部启用）
};

let diceLibrary = {};   // { 池名: { 类目: [语料...] } }
let settings = { ...defaultSettings };

// ---------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------

function getCtx() {
    try {
        return SillyTavern.getContext();
    } catch (e) {
        return null;
    }
}

function loadSettings() {
    const ctx = getCtx();
    if (!ctx || !ctx.extensionSettings) return;
    if (!ctx.extensionSettings[MODULE]) {
        ctx.extensionSettings[MODULE] = {};
    }
    settings = Object.assign({}, defaultSettings, ctx.extensionSettings[MODULE]);
    ctx.extensionSettings[MODULE] = settings;
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

// ---------------------------------------------------------------
// 骰子库：纯文本 <-> 库对象
//   # 卡池名   单井号 = 卡池
//   ## 类目名  双井号 = 类目
//   其余非空行 = 语料
// 空卡池/空类目会被保留（新建卡池后还没填语料也能显示出来）。
// ---------------------------------------------------------------

function parseDiceText(text) {
    const lib = {};
    let pool = '默认';
    let cat = '默认';
    const ensure = () => {
        if (!lib[pool]) lib[pool] = {};
        if (!lib[pool][cat]) lib[pool][cat] = [];
    };
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('##')) {
            cat = line.replace(/^#+\s*/, '').trim() || '默认';
            if (!lib[pool]) lib[pool] = {};
            if (!lib[pool][cat]) lib[pool][cat] = [];
            continue;
        }
        if (line.startsWith('#')) {
            pool = line.replace(/^#+\s*/, '').trim() || '默认';
            cat = '默认';
            if (!lib[pool]) lib[pool] = {};
            continue;
        }
        ensure();
        lib[pool][cat].push(line);
    }
    return lib;
}

// 单池片段（## 类目 + 语料行）-> 类目表；片段里出现的 # 行也宽容地并入
function poolFragmentToCatMap(text) {
    const parsed = parseDiceText(text);
    const out = {};
    for (const p of Object.keys(parsed)) {
        for (const c of Object.keys(parsed[p])) {
            if (!out[c]) out[c] = [];
            out[c] = out[c].concat(parsed[p][c]);
        }
    }
    return out;
}

function catMapToText(catMap) {
    return Object.entries(catMap || {})
        .map(([cat, items]) => `## ${cat}` + (items.length ? `\n${items.join('\n')}` : ''))
        .join('\n\n');
}

function poolsToText(lib) {
    return Object.entries(lib || {})
        .map(([pool, catMap]) => {
            const body = catMapToText(catMap);
            return `# ${pool}` + (body ? `\n${body}` : '');
        })
        .join('\n\n');
}

function libraryStats(lib) {
    const poolNames = Object.keys(lib || {});
    let cats = 0, total = 0;
    for (const p of poolNames) {
        const cs = Object.keys(lib[p]);
        cats += cs.length;
        for (const c of cs) total += lib[p][c].length;
    }
    return { pools: poolNames.length, cats, total };
}

function poolStats(catMap) {
    const cs = Object.keys(catMap || {});
    let total = 0;
    for (const c of cs) total += catMap[c].length;
    return { cats: cs.length, total };
}

function getActivePools() {
    const all = Object.keys(diceLibrary || {});
    const sel = Array.isArray(settings.activePools)
        ? settings.activePools.filter(p => all.includes(p))
        : [];
    return sel.length ? sel : all; // 没选 = 全部启用
}

async function fetchDefaultLibraryText() {
    const url = new URL('./dice.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`dice.json 读取失败: HTTP ${res.status}`);
    const json = await res.json();
    // 默认库是旧格式 { 类目: [...] }，转成 ## 文本（归入「默认」池）
    return Object.entries(json)
        .map(([cat, items]) => `## ${cat}\n${items.join('\n')}`)
        .join('\n\n');
}

// ---------------------------------------------------------------
// 状态提交中枢：所有改库的路径最后都汇到这里
// ---------------------------------------------------------------

function commitLibrary(opts) {
    const o = Object.assign({ rebuildEditors: false, rebuildChips: true, syncMaster: true }, opts || {});
    settings.diceText = poolsToText(diceLibrary);
    saveSettings();
    updateStatsLine();
    if (o.rebuildChips) renderPoolSelector();
    if (o.rebuildEditors) renderPoolEditors();
    if (o.syncMaster) {
        const $m = $('#dice_pert_library');
        if ($m.length && !$m.is(':focus')) $m.val(settings.diceText);
    }
}

// ---------------------------------------------------------------
// 骰子核心
// ---------------------------------------------------------------

function rollDice() {
    const pools = getActivePools();
    const cats = [];
    for (const p of pools) {
        for (const c of Object.keys(diceLibrary[p] || {})) {
            if (diceLibrary[p][c].length > 0) {
                cats.push({ pool: p, cat: c, items: diceLibrary[p][c] });
            }
        }
    }
    if (cats.length === 0) return null;

    if (settings.categoryFirst) {
        const c = cats[Math.floor(Math.random() * cats.length)];
        return { pool: c.pool, category: c.cat, text: c.items[Math.floor(Math.random() * c.items.length)] };
    }

    const all = [];
    for (const c of cats) {
        for (const item of c.items) all.push({ pool: c.pool, category: c.cat, text: item });
    }
    return all[Math.floor(Math.random() * all.length)];
}

// ---------------------------------------------------------------
// collectionId 过滤
// ---------------------------------------------------------------

function splitList(str) {
    return String(str || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function collectIds(body) {
    const ids = [];
    if (typeof body.collectionId === 'string') ids.push(body.collectionId);
    if (Array.isArray(body.collectionIds)) {
        for (const id of body.collectionIds) {
            if (typeof id === 'string') ids.push(id);
        }
    }
    return ids;
}

function idAllowed(id) {
    const wl = splitList(settings.whitelist);
    if (wl.length > 0) {
        return wl.some(w => id.includes(w));
    }
    const ex = splitList(settings.excludePrefixes);
    return !ex.some(p => id.startsWith(p));
}

function shouldPerturb(body) {
    const ids = collectIds(body);
    if (ids.length === 0) {
        return { perturb: true, ids: ['(无 collectionId)'] };
    }
    const allowed = ids.filter(idAllowed);
    return { perturb: allowed.length > 0, ids };
}

// ---------------------------------------------------------------
// roll 记录
// ---------------------------------------------------------------

const rollHistory = [];

function recordRoll(roll, repeat, ids) {
    const time = new Date().toLocaleTimeString();
    rollHistory.unshift(`${time} 🎲 [${roll.pool}/${roll.category}] ${roll.text} ×${repeat}`);
    if (rollHistory.length > 10) rollHistory.pop();
    const $box = $('#dice_pert_history');
    if ($box.length) $box.text(rollHistory.join('\n'));
    const $count = $('#dice_pert_history_count');
    if ($count.length) $count.text(rollHistory.length);

    if (settings.logRoll) {
        console.log(`${LOG_TAG} 🎲 [${roll.pool}/${roll.category}] ${roll.text} ×${repeat} → collection: ${ids.join(', ')}`);
    }
    if (settings.toastRoll && typeof toastr !== 'undefined') {
        toastr.info(`[${roll.pool}/${roll.category}] ${roll.text}`, '🎲 已注入', { timeOut: 3000 });
    }
}

// ---------------------------------------------------------------
// fetch 拦截
// ---------------------------------------------------------------

function isVectorQueryUrl(url) {
    // 宽松匹配：兼容 /api/vector/query、/api/vectors/query、query-multi、以及云端部署的路径前缀
    return url.includes('/vector') && url.includes('/query') && !url.includes('/insert') && !url.includes('/purge');
}

function installFetchHook() {
    if (window.__dicePerturbationInstalled) {
        console.warn(`${LOG_TAG} fetch 钩子已存在，跳过重复安装`);
        return;
    }
    const origFetch = window.fetch;

    window.fetch = async function (input, init) {
        try {
            if (settings.enabled && diceLibrary) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';

                if (isVectorQueryUrl(url) && init && typeof init.body === 'string') {
                    const body = JSON.parse(init.body);

                    if (typeof body.searchText === 'string' && body.searchText.length > 0) {
                        // WebLLM / KoboldCpp 的向量在浏览器端预先算好、按原文作 key 传递，
                        // 改文本会导致 key 对不上，必须放行
                        const clientSideEmbedding =
                            body.source === 'webllm' || body.source === 'koboldcpp' ||
                            (body.sourceSettings && body.sourceSettings.embeddings);
                        if (clientSideEmbedding) {
                            if (settings.logRoll) console.warn(`${LOG_TAG} ⛔ 检测到浏览器端嵌入来源（webllm/koboldcpp），本插件无法扰动该来源，已放行`);
                            return origFetch.call(this, input, init);
                        }

                        const { perturb, ids } = shouldPerturb(body);

                        if (perturb) {
                            const roll = rollDice();
                            if (roll) {
                                const repeat = Math.max(1, Math.min(10, Number(settings.repeat) || 1));
                                const injection = (roll.text + '\n').repeat(repeat);
                                body.searchText = injection + body.searchText;
                                init = Object.assign({}, init, { body: JSON.stringify(body) });

                                recordRoll(roll, repeat, ids);
                            }
                        } else if (settings.logRoll) {
                            console.log(`${LOG_TAG} ⛔ 已放行（过滤规则）→ collection: ${ids.join(', ')}`);
                        }
                    }
                }
            }
        } catch (e) {
            // 任何拦截环节出错都放行原请求，绝不让扰动失败拖垮检索本身
            console.warn(`${LOG_TAG} 拦截过程出错，已放行原请求`, e);
        }
        return origFetch.call(this, input, init);
    };

    window.__dicePerturbationInstalled = true;
    console.log(`${LOG_TAG} fetch 钩子已安装`);
}

// ---------------------------------------------------------------
// 卡池操作
// ---------------------------------------------------------------

function createNewPool() {
    const name = (window.prompt('新卡池的名字？（例如：剧情 / 情感 / 场景）') || '').trim();
    if (!name) return;
    if (name.includes('#')) {
        if (typeof toastr !== 'undefined') toastr.warning('池名里不要带 # 号', '🎲 骰子扰动');
        return;
    }
    if (Object.keys(diceLibrary).includes(name)) {
        if (typeof toastr !== 'undefined') toastr.warning(`卡池「${name}」已存在`, '🎲 骰子扰动');
        return;
    }
    diceLibrary[name] = { '默认': [] };
    commitLibrary({ rebuildEditors: true });
    // 新建后自动展开它的编辑框
    const $drawer = $(`#dice_pert_pool_editors .dice-pool-editor[data-pool-b64="${b64(name)}"]`);
    if ($drawer.length) {
        $drawer.find('.dice-pool-editor-content').show();
        $drawer.find('.dice-pool-editor-arrow').text('▼');
    }
    if (typeof toastr !== 'undefined') {
        toastr.success(`卡池「${name}」已创建，往它的框里填语料吧`, '🎲 骰子扰动');
    }
}

function deletePool(name) {
    if (!window.confirm(`确定删除卡池「${name}」吗？池里的语料会一起删除。`)) return;
    delete diceLibrary[name];
    if (Array.isArray(settings.activePools)) {
        settings.activePools = settings.activePools.filter(p => p !== name);
    }
    commitLibrary({ rebuildEditors: true });
    if (typeof toastr !== 'undefined') toastr.info(`卡池「${name}」已删除`, '🎲 骰子扰动');
}

function chipToggle(pool) {
    const all = Object.keys(diceLibrary || {});
    let sel = Array.isArray(settings.activePools)
        ? settings.activePools.filter(p => all.includes(p))
        : [];
    if (sel.length === 0) {
        sel = [pool];                         // 当前=全部：点谁就只用谁
    } else if (sel.includes(pool)) {
        sel = sel.filter(p => p !== pool);    // 取消选中；清空则回到全部
    } else {
        sel.push(pool);                       // 加选
    }
    settings.activePools = sel;
    saveSettings();
    renderPoolSelector();
    updateStatsLine();
}

// ---------------------------------------------------------------
// 设置面板 UI
// ---------------------------------------------------------------

// 池名 -> 安全的 DOM 标识（避免特殊字符进选择器）
function b64(s) {
    try {
        return btoa(unescape(encodeURIComponent(s))).replace(/[^a-zA-Z0-9]/g, '');
    } catch (e) {
        return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
    }
}

function updateStatsLine() {
    const { pools, cats, total } = libraryStats(diceLibrary);
    const hasSelection = Array.isArray(settings.activePools) && settings.activePools.length > 0;
    const actText = hasSelection ? `启用：${getActivePools().join('、')}` : '启用：全部';
    $('#dice_pert_stats').text(`${pools} 池 / ${cats} 类 / ${total} 条 · ${actText}`);
}

function renderPoolSelector() {
    const $box = $('#dice_pert_pools');
    if (!$box.length) return;
    const pools = Object.keys(diceLibrary);
    const active = getActivePools();
    const explicit = Array.isArray(settings.activePools) && settings.activePools.length > 0;
    $box.empty();

    const $row = $('<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;"></div>');

    if (pools.length > 1) {
        const $allChip = $('<input type="button" class="menu_button" />')
            .val(explicit ? '全部' : '✓ 全部')
            .css('opacity', explicit ? 0.55 : 1)
            .on('click', function () {
                settings.activePools = [];
                saveSettings();
                renderPoolSelector();
                updateStatsLine();
            });
        $row.append($allChip);

        for (const p of pools) {
            const isOn = active.includes(p);
            const $chip = $('<input type="button" class="menu_button" />')
                .val((explicit && isOn ? '✓ ' : '') + p)
                .css('opacity', isOn ? 1 : 0.55)
                .on('click', function () { chipToggle(p); });
            $row.append($chip);
        }
    } else {
        $row.append($('<small style="opacity:.7;"></small>')
            .text('目前只有一个卡池——点「新建卡池」分区（剧情/场景/情感），每个池会有自己的编辑框。'));
    }

    const $newBtn = $('<input type="button" class="menu_button" value="➕ 新建卡池" />')
        .on('click', createNewPool);
    $row.append($newBtn);

    $box.append($row);
}

// 每个卡池一个折叠编辑框
function renderPoolEditors() {
    const $wrap = $('#dice_pert_pool_editors');
    if (!$wrap.length) return;
    $wrap.empty();

    for (const pool of Object.keys(diceLibrary)) {
        const { cats, total } = poolStats(diceLibrary[pool]);

        const $editor = $('<div class="dice-pool-editor" style="border:1px solid var(--SmartThemeBorderColor, #888); border-radius:6px; margin:6px 0; overflow:hidden;"></div>')
            .attr('data-pool-b64', b64(pool));

        // 头部（自带开合，不依赖酒馆的 drawer 委托）
        const $arrow = $('<span class="dice-pool-editor-arrow" style="width:1.2em; display:inline-block;">▶</span>');
        const $title = $('<b></b>').text(`📦 ${pool}`);
        const $count = $('<span class="dice-pool-editor-count" style="opacity:.7; margin-left:6px;"></span>')
            .text(`（${cats} 类 / ${total} 条）`);
        const $header = $('<div style="display:flex; align-items:center; gap:4px; padding:6px 8px; cursor:pointer; user-select:none;"></div>')
            .append($arrow, $title, $count);

        // 内容
        const $content = $('<div class="dice-pool-editor-content" style="display:none; padding:0 8px 8px 8px;"></div>');
        const $ta = $('<textarea class="text_pole textarea_compact" rows="10" style="width:100%;"></textarea>')
            .attr('placeholder', '## 类目名\n一条语料\n另一条语料')
            .val(catMapToText(diceLibrary[pool]));
        const $del = $('<input type="button" class="menu_button" value="🗑 删除此池" style="margin-top:6px;" />')
            .on('click', function () { deletePool(pool); });
        $content.append($ta, $('<div></div>').append($del));

        $header.on('click', function () {
            const open = $content.is(':visible');
            $content.toggle(!open);
            $arrow.text(open ? '▶' : '▼');
        });

        // 池内编辑：只更新数据和总览/统计，不重建编辑框（保护光标）
        $ta.on('input', function () {
            diceLibrary[pool] = poolFragmentToCatMap(this.value);
            const s = poolStats(diceLibrary[pool]);
            $count.text(`（${s.cats} 类 / ${s.total} 条）`);
            commitLibrary({ rebuildEditors: false, rebuildChips: false });
        });

        $editor.append($header, $content);
        $wrap.append($editor);
    }
}

function settingsHtml() {
    return `
    <div class="dice-perturbation-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎲 骰子扰动</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="dice_pert_enabled">
                    <input id="dice_pert_enabled" type="checkbox" />
                    <span>启用扰动</span>
                </label>
                <label class="checkbox_label" for="dice_pert_log">
                    <input id="dice_pert_log" type="checkbox" />
                    <span>控制台打印 roll 结果（F12 查看）</span>
                </label>
                <label class="checkbox_label" for="dice_pert_toast">
                    <input id="dice_pert_toast" type="checkbox" />
                    <span>每次 roll 弹通知（手机端验证用）</span>
                </label>
                <label class="checkbox_label" for="dice_pert_catfirst">
                    <input id="dice_pert_catfirst" type="checkbox" />
                    <span>先抽类目再抽条目</span>
                </label>
                <div>
                    <label for="dice_pert_repeat">剂量（roll 结果重复次数）：<span id="dice_pert_repeat_value"></span></label>
                    <input id="dice_pert_repeat" type="range" min="1" max="10" step="1" />
                </div>
                <div>
                    <label for="dice_pert_exclude">排除前缀（逗号分隔，默认 file_ 保护 Data Bank）</label>
                    <input id="dice_pert_exclude" type="text" class="text_pole" placeholder="file_" />
                </div>
                <div>
                    <label for="dice_pert_whitelist">白名单（逗号分隔；非空时只扰动匹配的 collection）</label>
                    <input id="dice_pert_whitelist" type="text" class="text_pole" placeholder="留空 = 排除模式" />
                </div>
                <hr />
                <div id="dice_pert_pools" style="margin: 6px 0;"></div>
                <div>
                    <span>骰子库 — <span id="dice_pert_stats"></span></span>
                </div>
                <div id="dice_pert_pool_editors"></div>
                <div class="inline-drawer" style="margin-top: 8px;">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>📄 全库总览（高级）</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <small style="opacity:.7;">完整文本视图：<code># 卡池名</code> 开新卡池，<code>## 类目名</code> 开新类目。在这里批量整理时，上面的池编辑框会同步。</small>
                        <textarea id="dice_pert_library" class="text_pole textarea_compact" rows="14"
                            placeholder="# 卡池名&#10;## 类目名&#10;一条语料&#10;另一条语料"></textarea>
                    </div>
                </div>
                <div class="inline-drawer" style="margin-top: 8px;">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>🎲 最近 roll 记录（<span id="dice_pert_history_count">0</span>）</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <pre id="dice_pert_history" style="max-height: 160px; overflow-y: auto; white-space: pre-wrap; font-size: 0.85em; opacity: 0.85; margin: 4px 0;">（还没有记录——发一条消息试试）</pre>
                        <input id="dice_pert_clear_history" class="menu_button" type="button" value="清空记录" />
                    </div>
                </div>
                <div class="flex-container" style="margin-top: 8px;">
                    <input id="dice_pert_test" class="menu_button" type="button" value="试掷一次 🎲" />
                    <input id="dice_pert_reset" class="menu_button" type="button" value="恢复默认库" />
                </div>
            </div>
        </div>
    </div>`;
}

let masterInputTimer = null;

function handleMasterInput(value) {
    // 打字时保留用户原文，不立刻反序列化覆盖
    settings.diceText = value;
    diceLibrary = parseDiceText(value);
    saveSettings();
    updateStatsLine();
    // 结构与内容的重渲染做防抖，避免每个键击都重建编辑框
    if (masterInputTimer) clearTimeout(masterInputTimer);
    masterInputTimer = setTimeout(() => {
        renderPoolSelector();
        renderPoolEditors();
    }, 500);
}

function bindSettingsUI() {
    $('#dice_pert_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () { settings.enabled = this.checked; saveSettings(); });

    $('#dice_pert_log')
        .prop('checked', settings.logRoll)
        .on('change', function () { settings.logRoll = this.checked; saveSettings(); });

    $('#dice_pert_toast')
        .prop('checked', settings.toastRoll)
        .on('change', function () { settings.toastRoll = this.checked; saveSettings(); });

    $('#dice_pert_catfirst')
        .prop('checked', settings.categoryFirst)
        .on('change', function () { settings.categoryFirst = this.checked; saveSettings(); });

    $('#dice_pert_repeat')
        .val(settings.repeat)
        .on('input', function () {
            settings.repeat = Number(this.value);
            $('#dice_pert_repeat_value').text(this.value);
            saveSettings();
        });
    $('#dice_pert_repeat_value').text(settings.repeat);

    $('#dice_pert_exclude')
        .val(settings.excludePrefixes)
        .on('input', function () { settings.excludePrefixes = this.value; saveSettings(); });

    $('#dice_pert_whitelist')
        .val(settings.whitelist)
        .on('input', function () { settings.whitelist = this.value; saveSettings(); });

    $('#dice_pert_library')
        .val(settings.diceText)
        .on('input', function () { handleMasterInput(this.value); });

    $('#dice_pert_clear_history').on('click', function () {
        rollHistory.length = 0;
        $('#dice_pert_history').text('（已清空）');
        $('#dice_pert_history_count').text('0');
    });

    $('#dice_pert_test').on('click', function () {
        const roll = rollDice();
        if (roll) {
            const msg = `[${roll.pool}/${roll.category}] ${roll.text}`;
            console.log(`${LOG_TAG} 试掷 🎲 ${msg}`);
            if (typeof toastr !== 'undefined') toastr.info(msg, '🎲 骰子扰动');
        } else {
            if (typeof toastr !== 'undefined') toastr.warning('启用的卡池里没有语料', '🎲 骰子扰动');
        }
    });

    $('#dice_pert_reset').on('click', async function () {
        if (!window.confirm('确定用默认库覆盖当前骰子库吗？你写的所有卡池和语料都会被清掉。')) return;
        try {
            const text = await fetchDefaultLibraryText();
            settings.diceText = text;
            diceLibrary = parseDiceText(text);
            settings.activePools = [];
            $('#dice_pert_library').val(text);
            commitLibrary({ rebuildEditors: true });
            if (typeof toastr !== 'undefined') toastr.success('已恢复默认库', '🎲 骰子扰动');
        } catch (e) {
            console.error(`${LOG_TAG}`, e);
            if (typeof toastr !== 'undefined') toastr.error(String(e.message || e), '🎲 骰子扰动');
        }
    });

    // 初始渲染
    renderPoolSelector();
    renderPoolEditors();
    updateStatsLine();
}

function addSettingsUI() {
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    $(target).append(settingsHtml());
    bindSettingsUI();
}

// ---------------------------------------------------------------
// 斜杠命令 /dicepool —— 供 Quick Reply 一键切换卡池
//   /dicepool 剧情            只启用「剧情」池
//   /dicepool 情感,场景       同时启用两个池（逗号/顿号/加号分隔均可）
//   /dicepool 全部            清空选择 = 全部启用（all / 留空 同效）
//   /dicepool off             关闭扰动总开关；/dicepool on 重新打开
// ---------------------------------------------------------------

function setActivePoolsByName(value) {
    const v = String(value || '').trim();

    if (v === 'on' || v === '开') {
        settings.enabled = true;
        saveSettings();
        $('#dice_pert_enabled').prop('checked', true);
        return '🎲 扰动已开启';
    }
    if (v === 'off' || v === '关') {
        settings.enabled = false;
        saveSettings();
        $('#dice_pert_enabled').prop('checked', false);
        return '🎲 扰动已关闭';
    }

    const all = Object.keys(diceLibrary || {});
    let msg;
    if (!v || v === 'all' || v === '全部') {
        settings.activePools = [];
        msg = '🎲 卡池：全部启用';
    } else {
        const wanted = v.split(/[,，、+]+/).map(s => s.trim()).filter(Boolean);
        const valid = wanted.filter(p => all.includes(p));
        const invalid = wanted.filter(p => !all.includes(p));
        if (valid.length === 0) {
            return `🎲 没有匹配的卡池（现有：${all.join('、')}）`;
        }
        settings.activePools = valid;
        msg = `🎲 卡池已切换：${valid.join('、')}`;
        if (invalid.length) msg += `（未找到：${invalid.join('、')}）`;
    }
    saveSettings();
    renderPoolSelector();
    updateStatsLine();
    return msg;
}

function registerSlashCommand() {
    const ctx = getCtx();
    if (!ctx) return;
    const callback = (_namedArgs, value) => {
        const msg = setActivePoolsByName(value);
        if (typeof toastr !== 'undefined') toastr.info(msg, '🎲 骰子扰动', { timeOut: 2500 });
        return msg;
    };
    const help = '切换骰子扰动卡池：/dicepool 剧情 | /dicepool 情感,场景 | /dicepool 全部 | /dicepool on|off';
    try {
        if (ctx.SlashCommandParser && ctx.SlashCommand && typeof ctx.SlashCommand.fromProps === 'function') {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'dicepool',
                callback,
                helpString: help,
            }));
            console.log(`${LOG_TAG} 斜杠命令 /dicepool 已注册（新API）`);
            return;
        }
        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('dicepool', callback, [], help, true, true);
            console.log(`${LOG_TAG} 斜杠命令 /dicepool 已注册（旧API）`);
            return;
        }
        console.warn(`${LOG_TAG} 未找到斜杠命令注册接口，/dicepool 不可用（面板按钮仍可用）`);
    } catch (e) {
        console.warn(`${LOG_TAG} 斜杠命令注册失败，面板按钮仍可用`, e);
    }
}

// ---------------------------------------------------------------
// 入口
// ---------------------------------------------------------------

jQuery(async () => {
    try {
        loadSettings();

        // 首次启动：面板库为空时，用 dice.json 的默认内容垫底
        if (!settings.diceText || !settings.diceText.trim()) {
            try {
                settings.diceText = await fetchDefaultLibraryText();
                saveSettings();
            } catch (e) {
                console.warn(`${LOG_TAG} 默认库读取失败，骰子库为空，请在面板里填写`, e);
                settings.diceText = '';
            }
        }

        diceLibrary = parseDiceText(settings.diceText);
        addSettingsUI();
        installFetchHook();
        registerSlashCommand();

        const { pools, cats, total } = libraryStats(diceLibrary);
        console.log(`${LOG_TAG} v1.6.0 已就绪 | 启用: ${settings.enabled} | 剂量: ×${settings.repeat} | 骰子库: ${pools} 池 ${cats} 类 ${total} 条`);
    } catch (e) {
        console.error(`${LOG_TAG} 初始化失败`, e);
        if (typeof toastr !== 'undefined') {
            toastr.error('初始化失败，详见 F12 控制台', '🎲 骰子扰动');
        }
    }
});
