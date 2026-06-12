/**
 * 骰子扰动 (Dice Query Perturbation) v1.1.0
 *
 * 原理：拦截向量检索请求（/api/vector/query 与 /api/vector/query-multi），
 * 在 searchText 前注入随机抽取的意象短句（重复 N 次以保证剂量），
 * 使查询向量发生语义偏移，从而打散 top-k 命中结果。
 *
 * v1.1 变更：骰子库改为设置面板内直接编辑（纯文本格式，无需JSON），
 * 存储在酒馆配置中，云端/手机可用，即改即生效。
 * dice.json 仅作为首次启动的默认库来源保留。
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
    diceText: '',         // 骰子库正文（面板内编辑的纯文本格式）
    activePools: [],      // 启用的卡池名（空数组 = 全部启用）
};

let diceLibrary = null;
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
// 骰子库：纯文本格式 <-> 库对象
//
// 文本格式（打词儿就行）：
//   # 卡池名          ← 单井号 = 开一个新卡池（剧情 / 场景 / 情感……）
//   ## 类目名         ← 双井号 = 卡池内开一个类目
//   一条语料
//   另一条语料
//
// 没写任何 # 卡池行的内容自动归入「默认」池，完全兼容旧格式。
// ---------------------------------------------------------------

function parseDiceText(text) {
    const lib = {};   // { 池名: { 类目: [语料...] } }
    let pool = '默认';
    let cat = '默认';
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('##')) {
            cat = line.replace(/^#+\s*/, '').trim() || '默认';
            continue;
        }
        if (line.startsWith('#')) {
            pool = line.replace(/^#+\s*/, '').trim() || '默认';
            cat = '默认';
            continue;
        }
        if (!lib[pool]) lib[pool] = {};
        if (!lib[pool][cat]) lib[pool][cat] = [];
        lib[pool][cat].push(line);
    }
    return lib;
}

function libraryToText(lib) {
    // 仅用于把默认 dice.json（无池的旧格式 { 类目: [...] }）转成文本
    return Object.entries(lib)
        .map(([cat, items]) => `## ${cat}\n${items.join('\n')}`)
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

function getActivePools() {
    if (!diceLibrary) return [];
    const all = Object.keys(diceLibrary);
    const sel = Array.isArray(settings.activePools)
        ? settings.activePools.filter(p => all.includes(p))
        : [];
    return sel.length ? sel : all; // 全不勾 = 全部启用
}

async function fetchDefaultLibraryText() {
    const url = new URL('./dice.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`dice.json 读取失败: HTTP ${res.status}`);
    const json = await res.json();
    return libraryToText(json);
}

function updateStatsLine() {
    if (!diceLibrary) return;
    const { pools, cats, total } = libraryStats(diceLibrary);
    const hasSelection = Array.isArray(settings.activePools) && settings.activePools.length > 0;
    const actText = hasSelection ? `启用：${getActivePools().join('、')}` : '启用：全部';
    $('#dice_pert_stats').text(`${pools} 池 / ${cats} 类 / ${total} 条 · ${actText}`);
}

function createNewPool() {
    const name = (window.prompt('新卡池的名字？（例如：剧情 / 情感 / 场景）') || '').trim();
    if (!name) return;
    if (name.includes('#')) {
        if (typeof toastr !== 'undefined') toastr.warning('池名里不要带 # 号', '🎲 骰子扰动');
        return;
    }
    if (diceLibrary && Object.keys(diceLibrary).includes(name)) {
        if (typeof toastr !== 'undefined') toastr.warning(`卡池「${name}」已存在`, '🎲 骰子扰动');
        return;
    }
    const newText = (settings.diceText || '').replace(/\s+$/, '') + `\n\n# ${name}\n## 默认\n`;
    $('#dice_pert_library').val(newText);
    applyDiceText(newText);
    if (typeof toastr !== 'undefined') {
        toastr.success(`卡池「${name}」已创建——去骰子库末尾往它下面填语料`, '🎲 骰子扰动');
    }
}

function chipToggle(pool) {
    const all = Object.keys(diceLibrary || {});
    let sel = Array.isArray(settings.activePools)
        ? settings.activePools.filter(p => all.includes(p))
        : [];
    if (sel.length === 0) {
        // 当前=全部启用：点某个池 → 只用这个池（直白切换）
        sel = [pool];
    } else if (sel.includes(pool)) {
        sel = sel.filter(p => p !== pool);   // 取消选中；清空则回到全部
    } else {
        sel.push(pool);                       // 加选
    }
    settings.activePools = sel;
    saveSettings();
    renderPoolSelector();
    updateStatsLine();
}

function renderPoolSelector() {
    const $box = $('#dice_pert_pools');
    if (!$box.length || !diceLibrary) return;
    const pools = Object.keys(diceLibrary);
    const active = getActivePools();
    const explicit = Array.isArray(settings.activePools) && settings.activePools.length > 0;
    $box.empty();

    const $row = $('<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;"></div>');

    if (pools.length > 1) {
        // 「全部」胶囊
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

        // 每个池一个胶囊：高亮=启用中，点按直白切换
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
            .text('目前只有一个卡池——点「新建卡池」分区（剧情/场景/情感），分出来就能一键切换。'));
    }

    const $newBtn = $('<input type="button" class="menu_button" value="➕ 新建卡池" />')
        .on('click', createNewPool);
    $row.append($newBtn);

    $box.append($row);
}

function applyDiceText(text) {
    settings.diceText = text;
    diceLibrary = parseDiceText(text);
    renderPoolSelector();
    updateStatsLine();
    saveSettings();
}

// ---------------------------------------------------------------
// 骰子核心
// ---------------------------------------------------------------

function rollDice() {
    if (!diceLibrary) return null;
    const pools = getActivePools();
    const cats = [];
    for (const p of pools) {
        for (const c of Object.keys(diceLibrary[p])) {
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
// fetch 拦截
// ---------------------------------------------------------------

// 最近 roll 记录（仅存内存，刷新即清，最多 20 条）
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

function isVectorQueryUrl(url) {
    // 宽松匹配：兼容 /api/vector/query、/api/vectors/query、query-multi、以及云端部署的路径前缀
    // 显式排除 insert/purge 等其它向量端点
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
            console.warn(`${LOG_TAG} 拦截过程出错，已放行原请求`, e);
        }
        return origFetch.call(this, input, init);
    };

    window.__dicePerturbationInstalled = true;
    console.log(`${LOG_TAG} fetch 钩子已安装`);
}

// ---------------------------------------------------------------
// 设置面板 UI
// ---------------------------------------------------------------

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
                    <label for="dice_pert_library">
                        骰子库（<code># 卡池名</code> 开新卡池，<code>## 类目名</code> 开新类目，每行一条语料，改完即生效）
                        — <span id="dice_pert_stats"></span>
                    </label>
                    <textarea id="dice_pert_library" class="text_pole textarea_compact" rows="14"
                        placeholder="## 类目名&#10;一条语料&#10;另一条语料&#10;&#10;## 下一个类目&#10;……"></textarea>
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
        .on('input', function () { applyDiceText(this.value); });

    // 初始渲染：卡池选择器 + 统计
    renderPoolSelector();
    updateStatsLine();

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
            if (typeof toastr !== 'undefined') toastr.warning('骰子库为空', '🎲 骰子扰动');
        }
    });

    $('#dice_pert_reset').on('click', async function () {
        if (!confirm('确定用默认库覆盖当前骰子库吗？你写的内容会被清掉。')) return;
        try {
            const text = await fetchDefaultLibraryText();
            $('#dice_pert_library').val(text);
            applyDiceText(text);
            if (typeof toastr !== 'undefined') toastr.success('已恢复默认库', '🎲 骰子扰动');
        } catch (e) {
            console.error(`${LOG_TAG}`, e);
            if (typeof toastr !== 'undefined') toastr.error(String(e.message || e), '🎲 骰子扰动');
        }
    });
}

function addSettingsUI() {
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    $(target).append(settingsHtml());
    bindSettingsUI();
}

// ---------------------------------------------------------------
// 入口
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// 斜杠命令 /dicepool —— 供 Quick Reply 一键切换卡池
//   /dicepool 剧情            只启用「剧情」池
//   /dicepool 情感,场景       同时启用两个池（逗号/顿号/加号分隔均可）
//   /dicepool 全部            清空选择 = 全部启用（all / 留空 同效）
//   /dicepool off             关闭扰动总开关；/dicepool on 重新打开
// ---------------------------------------------------------------

function setActivePoolsByName(value) {
    if (!diceLibrary) return '🎲 骰子库未加载';
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

    const all = Object.keys(diceLibrary);
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
        console.warn(`${LOG_TAG} 未找到斜杠命令注册接口，/dicepool 不可用（面板勾选仍可用）`);
    } catch (e) {
        console.warn(`${LOG_TAG} 斜杠命令注册失败，面板勾选仍可用`, e);
    }
}

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
        console.log(`${LOG_TAG} v1.5.0 已就绪 | 启用: ${settings.enabled} | 剂量: ×${settings.repeat} | 骰子库: ${pools} 池 ${cats} 类 ${total} 条`);
    } catch (e) {
        console.error(`${LOG_TAG} 初始化失败`, e);
        if (typeof toastr !== 'undefined') {
            toastr.error('初始化失败，详见 F12 控制台', '🎲 骰子扰动');
        }
    }
});
