//////////////////////////////////////////////
// content.js
//////////////////////////////////////////////
let VERSION = "1.0.0";

const UPDATE_URL =
    "https://blog.ai-canvas.org/wp-content/plugins/ai-comment-replier-manager/update.php";

// API 端点（基础 URL）
const API_URL = "https://api.ai-canvas.org";



// 轮询间隔（分钟） 与 延迟对象
const CHECK_INTERVAL = 5;
let mainDelayObj = null;

// 全局日记数组和最大记录数
const diaryEntries = [];
const MAX_DIARY_ENTRIES = 50;

// 全局变量：用户信息
let userInfo = {
    user_id: null,
    user_name: null,
    shop_name: null,
    api_key: null,
    key_type: null,
    expiration_date: null,
};

// 全局变量：选择器（从服务器动态获取）
let selectors = {};

// 全局标记：表示脚本是否正在监控中
let running = false;

// popup.js 存活状态
let popupAlive = false;

let isUserInfoValid = false;
let isSelectorsValid = false;
let isHidden = false;


// 调试模式
const DEBUG = false;


// 系统提示 与 生成回复内容的格式
const system_pormpt =
    "당신은 배달음식점 고객의 리뷰를 분석하고 고품질의 응답을 생성하는 전문 AI 리뷰 분석가입니다. 목표는 고객 만족도를 높이고 브랜드 이미지를 강화하며, 친절하고 전문적인 톤으로 고객의 리뷰에 댓글을 생성합니다."

    + "-- 핵심 요구 사항 --"

    + "리뷰 내용 이해:"
    + "고객 리뷰를 분석하여 감정적 성향(긍정적, 중립적, 부정적)과 핵심 요구 사항(칭찬, 제안, 불만, 문의 등)을 정확하게 파악합니다."

    + "톤 조절:"
    + "긍정적인 리뷰: 감사 인사를 전하고 브랜드 가치를 강조하며 고객과의 지속적인 상호작용을 유도합니다."

    + "부정적인 리뷰:"
    + "고객의 불편 사항을 경청하고 공감하며, 해결책을 제시하여 긍정적인 경험을 유도합니다."
    + "사실 확인이 필요한 경우, 고객과 직접 소통할 수 있도록 안내하여 문제를 원활하게 해결할 수 있도록 돕습니다."
    + "즉각적인 사과 대신 '유감스럽다'는 표현을 사용하여 브랜드의 신뢰성을 유지합니다."

    + "개인화된 응답:"
    + "정형화된 답변을 지양하고, 고객 리뷰의 특정 내용을 반영하여 보다 자연스럽고 따뜻한 응답을 생성합니다."

    + "브랜드 일관성 유지:"
    + "브랜드의 음성(공식적, 친근함, 전문적, 유머러스함 등)을 유지하여 브랜드 이미지를 강화합니다."

    + "민감한 문제 회피:"
    + "고객의 리뷰가 악의적이거나 허위 정보가 포함된 경우, 차분하고 전문적인 방식으로 대응하며 불필요한 논쟁을 피합니다."
    + "브랜드의 원칙과 신뢰성을 강조하면서도 고객과의 원만한 소통을 유도합니다.";







/**
 * 异步延迟函数，支持中途取消
 * @param {number} ms - 延迟时间（毫秒）
 * @returns {Promise} - 返回一个 Promise 对象
 */
function createDelay(ms) {
    let timer = null;
    let rejectFunc = null;

    const promise = new Promise((resolve, reject) => {
        rejectFunc = reject;
        timer = setTimeout(resolve, ms);
    });

    return {
        promise,
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                rejectFunc(new Error("Delay cancelled"));
            }
        }
    };
}

async function Delay(ms) {
    // 创建延迟对象
    const delayObj = createDelay(ms); // 立即返回一个延迟对象

    // 等待延迟结束
    await delayObj.promise
        .then(() => debugLog("延迟结束"))
        .catch(err => debugLog(`被取消：${err.message}`));
}


/**
 * 控制台日志函数：仅在 DEBUG 模式下输出
 * @param {string} message - 要输出的日志信息
 */
function debugLog(message) {
    if (DEBUG) {
        console.log(message);
    }
}

/**
 * 写日志函数：同时发送给 popup.js
 * @param {string} diary - 要记录的日志信息
 */
function logDiary(diary) {
    if (typeof diary !== "string" || diary.trim() === "") {
        debugLog("无效的日记内容，无法记录。");
        return;
    }

    // 格式化时间戳
    const now = new Date();
    const timestamp = now.toLocaleString("default", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    

    // 封装内容
    const formattedDiary = `<span style="font-size: 10px; color: #7e8082;">${timestamp}</span><br>${diary}`;

    // 如果记录数超过最大限制，删除最旧的一条
    if (diaryEntries.length >= MAX_DIARY_ENTRIES) {
        diaryEntries.shift();
    }

    // 存储日志
    diaryEntries.push(formattedDiary);

    // 主动发送消息到 popup.js
    if (popupAlive) {
        chrome.runtime.sendMessage(
            { type: "newDiaryEntry", data: formattedDiary },
            (response) => {
                if (chrome.runtime.lastError) {
                    debugLog(`发送消息到 popup.js 失败: ${chrome.runtime.lastError.message}`);
                }
            }
        );
    }
}

/**
 * 查找包含指定内容的按钮，并点击
 * @param {string} textContent - 按钮文本内容
 * @returns {boolean} - 是否找到并点击了按钮
 */
function clickDismissButton(textContent) {
    const buttons = document.querySelectorAll("button");
    for (const button of buttons) {
        if (button.textContent.trim().includes(textContent)) {
            button.click();
            return true;
        }
    }
    return false;
}

/**
 * 关闭（或删除）弹窗
 * 说明：使用 selectors.popup_modal 和 selectors.popup_close_button
 *       动态获取元素选择器，而非硬编码
 */
function killPopup() {
    clickDismissButton("오늘 하루 보지 않기");
    clickDismissButton("일주일 동안 보지 않기");

    // 根据 selectors 动态选择器获取弹窗元素
    const modal = document.querySelector(selectors.popup_modal);
    if (modal) {
        debugLog("检测到弹窗元素");
        logDiary("팝업창이존재합니다.");

        // 查找关闭按钮
        const closeButton = modal.querySelector(selectors.popup_close_button);
        if (closeButton) {
            debugLog("找到关闭按钮，尝试点击...");
            logDiary("팝업창을닫습니다.");
            closeButton.click(); // 模拟点击关闭按钮
        } else {
            debugLog("未找到关闭按钮，移除弹窗...");
            logDiary("팝업창을제거합니다.");
            modal.remove(); // 如果没有关闭按钮，直接移除弹窗
        }
    } else {
        debugLog("未检测到弹窗元素");
    }
}

/**
 * 关闭聊天机器人弹窗
 */
function killChatbot() {
    // 根据 selectors 动态选择器获取弹窗元素
    const modal = document.querySelector(selectors.chatbot_modal);
    if (modal) {
        debugLog("检测到弹窗元素");
        logDiary("챗봇이존재합니다.");

        // 查找关闭按钮
        const closeButton = modal.querySelector(selectors.chatbot_close_button);
        if (closeButton) {
            debugLog("找到关闭按钮，尝试点击...");
            logDiary("챗봇창을닫습니다.");
            closeButton.click(); // 模拟点击关闭按钮
        } else {
            debugLog("未找到关闭按钮，移除弹窗...");
            logDiary("챗봇창을제거합니다.");
            modal.remove(); // 如果没有关闭按钮，直接移除弹窗
        }
    } else {
        debugLog("未检测到弹窗元素");
    }
}

/**
 * 点击 “리뷰관리” 按钮
 */
function clickReviewButton() {
    // 使用 selectors.review_management_button 获取目标按钮
    const elements = document.querySelectorAll(selectors.review_management_button);

    // 找到文本为“리뷰관리”的目标元素
    const targetElement = Array.from(elements).find(
        (el) => el.textContent.trim() === selectors.review_management_button_text
    );

    if (targetElement) {
        targetElement.click();
    } else {
        debugLog("未找到 '리뷰관리' 按钮");
    }
}

/**
 * 轮换下拉菜单选项
 */
function rotateSelectOption() {
    const selectElement = document.querySelector(selectors.select_dropdown);
    if (!selectElement) {
        debugLog("未找到下拉菜单，跳过本次轮换...");
        return false;
    }

    const options = Array.from(selectElement.options);
    if (options.length < 2) {
        debugLog("下拉菜单选项不足，无法轮换...");
        return false;
    }

    const currentIndex = options.findIndex((option) => option.selected);
    if (currentIndex === -1) {
        debugLog("未找到当前选中选项...");
        return false;
    }

    // 下一个选项索引
    const nextIndex = (currentIndex + 1) % options.length;
    selectElement.value = options[nextIndex].value;

    // 触发原生 change 事件
    const changeEvent = new Event("change", { bubbles: true });
    selectElement.dispatchEvent(changeEvent);

    logDiary(`${options[nextIndex].textContent.trim()} 으로 이동합니다.`);
    debugLog(`切换到下拉菜单选项: ${options[nextIndex].textContent.trim()}`);
    return true;
}


/**
 * 调用远程接口生成回复
 * @param {string} commentInfo - 拼接好的评论信息
 * @returns {string|null} - 生成的回复，如果失败则返回 null
 */
async function generateReply(commentInfo) {
    try {
        const response = await fetch(`${API_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: userInfo.api_key,
            },
            body: JSON.stringify({
                messages: [
                    {
                        "role": "system",
                        "content": system_pormpt
                    },
                    {
                        role: "user",
                        content: commentInfo,
                    },
                ],
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`${response.status} : ${errorData.detail}`);
        }

        const data = await response.json();
        if (data.choices && data.choices.length > 0 && data.choices[0].message) {
            return data.choices[0].message.content;
        } else {
            throw new Error("API Error!");
        }
    } catch (error) {
        debugLog(`API Error：${error.message}`);
        logDiary(`API Error：${error.message}`);
        return null;
    }
}

/**
 * 等待元素出现, 返回元素对象
 * @param {string} selector - 元素选择器
 * @param {HTMLElement} parent - 父级元素，默认为 document.
 * @param {number} timeoutMs - 超时时间，默认为 3000ms.
 * @returns {Promise<HTMLElement>} - 返回 Promise 对象
 */
function waitForElement(selector, parent = document, timeoutMs = 3000) {
    // 先检查一次
    const existing = parent.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    // 再用 MutationObserver
    return new Promise((resolve, reject) => {
        let observer;
        const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("Timeout waiting for element"));
        }, timeoutMs);

        observer = new MutationObserver(() => {
            const element = parent.querySelector(selector);
            if (element) {
                clearTimeout(timer);
                observer.disconnect();
                resolve(element);
            }
        });
        observer.observe(parent, { childList: true, subtree: true });
    });
}

/**
 * 从单个卡片提取所需信息并自动回复
 * @param {HTMLElement} card - 单个评论卡片
 */
async function processCard(card) {



    // 找到回复输入框
    let replyInput = card.querySelector(selectors.reply_input);

    // 如果没有输入框，则点击按钮
    if (!replyInput) {
        const replyButton = Array.from(
            card.querySelectorAll(selectors.reply_button)
        ).find(
            (btn) => btn.textContent.trim() === selectors.reply_button_text
        );

        if (replyButton) {
            replyButton.click();
            try {
                replyInput = await waitForElement(selectors.reply_input, card);
            } catch (error) {
                debugLog(`等待回复输入框超时: ${error.message}`);
                return;
            }
        }
    }

    if (!replyInput) {
        debugLog("未找到回复输入框，跳过");
        return;
    }

    // 提取昵称
    const nicknameElem = card.querySelector(selectors.nickname);
    const nickname = nicknameElem ? nicknameElem.textContent.trim() : "";

    // 提取评论内容
    const reviewElem = card.querySelector(selectors.review_content);
    const reviewContent = reviewElem ? reviewElem.textContent.trim() : "";
    if (!nickname && !reviewContent) {
        debugLog("昵称和评论内容均为空，跳过");
        return;
    }

    // 提取购买商品信息
    const items = Array.from(card.querySelectorAll(selectors.menu_item));
    const purchasedItems = items.map((item) => item.textContent.trim()).join(" | ");

    // 提取评分
    const stars = Array.from(card.querySelectorAll(selectors.rating_stars));
    const ratingScore = stars.filter(
        (star) => star.getAttribute("fill") === selectors.rating_star_filled
    ).length;

    // 提取骑手评价（如果需要）
    const riderCommentsElems = Array.from(card.querySelectorAll(selectors.rider_comments));
    const riderComments = riderCommentsElems
        .map((comment) => comment.textContent.trim())
        .join(" | ");

    debugLog(`附加内容: ${purchasedItems}, ${ratingScore}, ${riderComments}`);

    // 拼接评论信息，传给 AI 生成
    const commentInfo = `닉네임: ${nickname}, 별점: ${ratingScore}/5, 메뉴: ${purchasedItems}, 리뷰: ${reviewContent}, 라이더평가: ${riderComments}`;
    const replyText = await generateReply(commentInfo);
    if (!replyText) return;


    // 填写并提交回复
    if (!isHidden) {
        await typeReplyText(replyInput, replyText);
    } else {
        replyInput.value = replyText;
        replyInput.dispatchEvent(new Event("input", { bubbles: true }));
    }


    // 查找确认按钮并点击
    const confirmButton = Array.from(card.querySelectorAll(selectors.confirm_button)).find(
        (button) => button.textContent.trim() === selectors.confirm_button_text
    );
    if (confirmButton) {
        confirmButton.click();

        logDiary(
            `<div style = "border-radius: 8px;box-shadow: 0 5px 24px 0 rgba(66,69,79,.05),0 3px 12px 0 rgba(66,69,79,.05),0 0 0 1px rgba(66,69,79,.01); background-color: #fff; padding: 10px"><span style = "font-size: 10px; color: #7e8082;">닉네임: ${nickname}  별점: ${ratingScore}  메뉴: ${purchasedItems}  라이더평가: ${riderComments}<br>리뷰:<br>${reviewContent}<br>댓글:</span >\n<span style = "font-size: 12px; color: #1a7cff;">${replyText}</span><div>`
        );
        debugLog("确认按钮已点击，回复已提交。");
    } else {
        debugLog("未找到确认按钮");
    }
}

/**
 * 处理页面上的所有卡片
 */
async function processCards() {

    // 获取所有评论列表
    const reviewLists = document.querySelectorAll(selectors.review_list);
    if (reviewLists.length === 0) {
        debugLog("未检测到 review-list");
        return;
    }

    // 遍历所有评论列表
    for (const list of reviewLists) {
        const cards = list.querySelectorAll(selectors.review_card);
        for (let i = 0; i < cards.length; i++) {
            await processCard(cards[i]);
        }
    }
}

/**
 * 主任务循环：轮询进行弹窗检测 -> 切换 -> 处理评论
 */
async function mainLoop() {


    // 检查选择器
    if (isUserInfoValid) {
        await fetchSelectors();
        if (!isSelectorsValid) {
            debugLog("选择器无效，无法启动任务");
            logDiary("선택기가유효하지 않습니다. 작업을시작할수없습니다.");
            return false;
        }
    }

    // 检查更新
    const manifest = chrome.runtime.getManifest();
    VERSION = manifest.version;
    await checkVersion();

    logDiary("리뷰모니터링 을 시작하였습니다.");
    running = true;

    while (running) {
        // 1) 关闭可能出现的弹窗
        killPopup();
        killChatbot();

        // 创建延迟对象，并等待延迟结束
        mainDelayObj = createDelay(1000);
        await mainDelayObj.promise
            .then(() => debugLog("延迟结束"))
            .catch(err => debugLog(`被取消：${err.message}`));
        if (!running) {
            break;
        }   

        // 2) 点击 “리뷰관리” 按钮
        clickReviewButton();

        // 创建延迟对象，并等待延迟结束
        mainDelayObj = createDelay(3000);
        await mainDelayObj.promise
            .then(() => debugLog("延迟结束"))
                .catch(err => debugLog(`被取消：${err.message}`));
        if (!running) {
            break;
        }

        // 3) 处理所有卡片
        await processCards();
  

        // 4) 等待 N 分钟，再轮询一次
        mainDelayObj = createDelay(60000 * CHECK_INTERVAL);
        await mainDelayObj.promise
            .then(() => debugLog("延迟结束"))
            .catch(err => debugLog(`被取消：${err.message}`));
        if (!running) {
            break;
        }

        // 5) 轮换下拉菜单选项，以防止页面长时间不更新
        rotateSelectOption();

        mainDelayObj = createDelay(3000);
        await mainDelayObj.promise
            .then(() => debugLog("延迟结束"))
            .catch(err => debugLog(`被取消：${err.message}`));
    }

    logDiary("리뷰모니터링 이 중지되었습니다.");
}

/**
 * 监听来自 popup.js 的消息，控制脚本的启停
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    debugLog(`收到指令: ${message.action}`);
    if (message.action === "start") {
        if (!isUserInfoValid) {
            debugLog("用户信息无效，无法启动任务");
            logDiary("사용자 정보가유효하지 않습니다. 작업을시작할수없습니다.");
            sendResponse({ running });
            return false;
        }


        if (!running) {
            logDiary("준비가완료되면, 리뷰모니터링 작업을 시작할예정입니다.");

            mainLoop();
            sendResponse({ running: true });
        } else {
            debugLog("任务已在运行中");
        }
    } else if (message.action === "stop") {
        running = false;
        mainDelayObj.cancel();
        sendResponse({ running: false });
        logDiary("진행중인 작업이끝나면, 리뷰모니터링 을 중지할예정입니다.");
    } else if (message.action === "getStatus") {
        sendResponse({ running });
    } else if (message.action === "getLog") {
        sendResponse({ logs: diaryEntries });
    } else if (message.action === "setUserInfo") {
        if (!isUserInfoValid) {
            userInfo = message.data;
            isUserInfoValid = userInfo && userInfo.api_key && userInfo.shop_name;

        }
        sendResponse({ userInfo: isUserInfoValid });
    } else if (message.action === "clearUserInfo") {
        isUserInfoValid = false;

    } else if (message.action === "popupOpened") {
        popupAlive = true;
        sendResponse({ popupAlive: true });
    } else if (message.action === "popupClosed") {
        popupAlive = false;
        sendResponse({ popupAlive: false });
    }
});



/**
 * 异步向服务器获取选择器配置
 * @param {number} retryCount - 重试次数
 * @param {number} retryDelay - 重试延迟（毫秒）
 * @returns {boolean} - 是否成功获取选择器
 */
async function fetchSelectors(retryCount = 3, retryDelay = 2000) {
    if (!userInfo.api_key) {
        debugLog("API Key 缺失，无法获取选择器数据");
        return false;
    }

    const selectorsUrl = `${API_URL}/v1/selectors`;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            debugLog(`尝试获取选择器 (第 ${attempt} 次)...`);

            const response = await fetch(selectorsUrl, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: userInfo.api_key,
                },
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`${response.status} : ${errorData.detail}`);
            }

            selectors = await response.json();
            isSelectorsValid = selectors && Object.keys(selectors).length > 0;

            debugLog(`选择器数据: ${JSON.stringify(selectors)}`);
            return true;
        } catch (error) {
            debugLog(`获取选择器失败 (尝试 ${attempt}/${retryCount}) : ${error.message}`);

            if (attempt < retryCount) {
                debugLog(`等待 ${retryDelay / 1000} 秒后重试...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } else {
                debugLog("所有重试尝试均失败，设置 selectors 为空对象");
                selectors = {}; // 失败后赋值为空对象，避免后续空引用
                logDiary(`API Error： ${error.message}`);
            }
        }
    }

    return false;
}


// 监听页面可见性变化，不可见时标记 popup.js 存活状态为 false
document.addEventListener("visibilitychange", () => {

    isHidden = document.hidden;

    if (isHidden) {
        popupAlive = false;
        debugLog("用户离开此标签页, 重置 popupAlive 为 false");
    }
});

/**
 * 带重试的 fetch 函数
 * 
 * @param {any} url         - 请求 URL
 * @param {any} options     - 请求配置
 * @param {any} retryCount  - 重试次数
 * @param {any} retryDelay  - 重试延迟（毫秒）
 */
async function fetchWithRetry(url, options, retryCount = 3, retryDelay = 2000) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 403) {
                const errorMessage = await response.text();
                throw new Error(errorMessage);
            }
            if (!response.ok) {
                throw new Error(`请求失败: ${response.status}`);
            }
            return await response.text();
        } catch (error) {
            debugLog(`请求失败 (第 ${attempt} 次): ${error.message}`);
            if (attempt < retryCount) {
                debugLog(`等待 ${retryDelay / 1000} 秒后重试...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } else {
                throw error;
            }
        }
    }
}


// 检查更新
async function checkVersion() {
    if (!userInfo.api_key) {
        debugLog("API Key 缺失，无法检查更新");
        return;
    }

    logDiary(`버전체크 중입니다...`);

    try {
        const versionText = await fetchWithRetry(
            `${UPDATE_URL}?action=version`,
            {
                method: "GET",
                headers: {
                    "Content-Type": "text/plain",
                },
            }
        );

        if (versionText) {
            if (VERSION.trim() !== versionText.trim()) {
                logDiary(
                    `최신버전:[<span style="color: #1a7cff;">${versionText}</span>] 으로 <a href="${UPDATE_URL}?action=get_zip&name=${userInfo.user_name}&key=${userInfo.api_key}" target="_blank">업데이트</a> 해주세요.<br>현재버전은 정상작동하지않을수 있습니다.`
                );
            } else {
                logDiary(`최신버전입니다.`);
            }
        }
    } catch (error) {
        debugLog(`检查更新时发生错误: ${error.message}`);
        logDiary(`버전체크 실패하였습니다. ${error.message}`);
    }
}

/**
 * 为输入框逐字输入文本
 * 
 * @param {any} replyInput - 输入框元素
 * @param {any} replyText  - 要输入的文本
 * @param {any} delay_ms   - 输入延迟（毫秒）
 * @param {any} options    - 配置选项
 */
async function typeReplyText(
    replyInput,
    replyText,
    delay_ms = 50,
    options = {
        checkVisibility: true,
        autoScroll: true,
        scrollBehavior: 'smooth'
    }
) {
    // 元素类型验证
    if (!(replyInput instanceof HTMLInputElement) &&
        !(replyInput instanceof HTMLTextAreaElement)) {
        debugLog("无效的输入框元素");
        return;
    }

    // 增强的滚动到视窗中央逻辑
    const scrollToCenter = async (element) => {
        const viewportHeight = window.innerHeight;
        const elementRect = element.getBoundingClientRect();
        const scrollTarget = window.scrollY + elementRect.top - (viewportHeight / 2) + (elementRect.height / 2);

        // 使用两种方式确保平滑滚动
        if ('scrollBehavior' in document.documentElement.style) {
            window.scrollTo({
                top: scrollTarget,
                behavior: options.scrollBehavior
            });
        } else {
            // 兼容旧版浏览器的渐进式滚动
            const start = window.scrollY;
            const distance = scrollTarget - start;
            const duration = 500;
            let startTime = null;

            // 动画函数
            const animation = (currentTime) => {
                if (!startTime) startTime = currentTime;
                const timeElapsed = currentTime - startTime;
                const progress = Math.min(timeElapsed / duration, 1);

                window.scrollTo(0, start + distance * progress);

                if (timeElapsed < duration) {
                    requestAnimationFrame(animation);
                }
            };
            requestAnimationFrame(animation);
        }

        // 更智能的滚动等待
        await new Promise(resolve => {
            const checkScroll = () => {
                if (Math.abs(window.scrollY - scrollTarget) < 5) {
                    resolve();
                } else {
                    requestAnimationFrame(checkScroll);
                }
            };
            checkScroll();
        });
    };

    // 可视检测与滚动处理
    if (options.checkVisibility) {
        const isVisible = isElementCentered(replyInput);

        if (!isVisible && options.autoScroll) {
            debugLog("正在将输入框滚动到视窗中央...");
            await scrollToCenter(replyInput);
        }
    }

    // 通过局部变量存储输入内容，减少 DOM 操作
    let currentText = "";

    // 使用更简洁的事件配置对象
    const eventOptions = { bubbles: true };

    // 清空输入框并触发初始事件
    replyInput.value = currentText;
    replyInput.dispatchEvent(new Event("input", eventOptions));

    // 使用现代循环语法提升可读性
    for (const char of replyText) {

        currentText += char;
        replyInput.value = currentText;

        // 触发带冒泡的输入事件
        replyInput.dispatchEvent(new Event("input", eventOptions));

        await Delay(delay_ms);
    }

    debugLog(`输入完成: ${replyText}`);
}

/** 改进后的可视区域检测
 * @param {HTMLElement} el - 要检测的元素
 * @returns {boolean} - 是否在视窗中间1/3区域
 */
function isElementCentered(el) {
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const elementCenterY = rect.top + rect.height / 2;

    // 判断元素中心点是否在视窗中间1/3区域
    return elementCenterY > viewportHeight / 3 &&
        elementCenterY < viewportHeight * 2 / 3;
}


// 页面加载完成后执行
(async () => {


    debugLog("content.js 已加载");



    // 这里不直接调用 mainLoop，由 popup.js 发消息 "start" 时再启动
})();
