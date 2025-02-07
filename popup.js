document.addEventListener("DOMContentLoaded", initPopup);


/** 全局变量 */
let isRunning = false;
let isLogin = false;
let contentTabId = null;

// 存储用户信息
const userinfo = {
    user_id: null,
    user_name: null,
    shop_name: null,
    api_key: null,
    key_type: null,
    expiration_date: null,
};


/**
 * 从 chrome.storage 读取用户信息，包含错误处理
 * @returns {Promise<object>} 返回读取到的用户信息
 */
async function getUserInfoFromStorage() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(
            [
                "acr_bm_user_id",
                "acr_bm_user_name",
                "acr_bm_shop_name",
                "acr_bm_api_key",
                "acr_bm_key_type",
                "acr_bm_expiration_date"
            ],
            (result) => {
                // 如果发生错误
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }

                // 更新全局 userinfo
                userinfo.user_id = result.acr_bm_user_id || null;
                userinfo.user_name = result.acr_bm_user_name || null;
                userinfo.shop_name = result.acr_bm_shop_name || null;
                userinfo.api_key = result.acr_bm_api_key || null;
                userinfo.key_type = result.acr_bm_key_type || null;
                userinfo.expiration_date = result.acr_bm_expiration_date || null;

                resolve({ ...userinfo });
            }
        );
    });
}

/**
 * 保存用户信息到 chrome.storage，包含错误处理
 * @param {object} data 用户数据 { user_id, user_name, shop_name, api_key, expiration_date }
 * @returns {Promise<void>}
 */
async function saveUserInfoToStorage(data) {
    return new Promise((resolve, reject) => {
        // 同步更新全局 userinfo
        userinfo.user_id = data.user_id;
        userinfo.user_name = data.user_name;
        userinfo.shop_name = data.shop_name;
        userinfo.api_key = data.api_key;
        userinfo.key_type = data.key_type;
        userinfo.expiration_date = data.expiration_date;

        chrome.storage.local.set(
            {
                acr_bm_user_id: data.user_id,
                acr_bm_user_name: data.user_name,
                acr_bm_shop_name: data.shop_name,
                acr_bm_api_key: data.api_key,
                acr_bm_key_type: data.key_type,
                acr_bm_expiration_date: data.expiration_date
            },
            () => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve();
            }
        );
    });
}



/** 初始化 Popup 主流程 */
async function initPopup() {
    console.log("popup.js 已加载");

    // 初始化并获取关键 DOM 元素
    const {
        toggleButton,
        logContainer,
        loginFormContainer,
        logoutButton,
        loginForm,
        loginBtn,
    } = initUI();
    let contentTab = null;
    // 尝试获取当前活动标签页 ID
    try {
        contentTab = await getActiveTab();
        contentTabId = contentTab.id;
    } catch (err) {
        console.log("获取活动标签页失败:", err);
        return;
    }

    // 如果不是 baemin.com 页面，不进行后续操作
    const urlObj = new URL(contentTab.url);
    if (urlObj.hostname !== "self.baemin.com") {
        showLoginMessage('배민 <a href="https://self.baemin.com" target="_blank" rel="noopener noreferrer">셀프서비스</a> 에서만 사용가능합니다.', true);
        return;
    }
    

    try {
        await getUserInfoFromStorage();
    } catch (error) {
        console.log("从 chrome.storage 读取用户信息出错:", error);
    }
    


    // 根据是否有有效的 userinfo 来更新 UI
    updateLoginState(loginFormContainer, logoutButton);

    // 如果已经登录，初始化与 Content 脚本的通信
    if (isLogin) {
        await handleLoggedInState(toggleButton, logContainer);
    }

    // 注册事件监听
    addEventListeners({
        toggleButton,
        logContainer,
        loginFormContainer,
        logoutButton,
        loginForm,
        loginBtn,
    });
}

/** 
 * 初始化UI、获取必要的DOM元素并进行基础验证 
 * 可根据需求进一步封装 
 */
function initUI() {
    const toggleButton = getElementOrLogError("toggleButton");
    const logContainer = getElementOrLogError("logContainer");
    const loginFormContainer = getElementOrLogError("loginFormContainer");
    const logoutButton = getElementOrLogError("logout-btn");
    const loginForm = getElementOrLogError("loginForm");
    const loginBtn = getElementOrLogError("login_bt");

    return {
        toggleButton,
        logContainer,
        loginFormContainer,
        logoutButton,
        loginForm,
        loginBtn,
    };
}

/** 注册所有事件监听 */
function addEventListeners({
    toggleButton,
    logContainer,
    loginFormContainer,
    logoutButton,
    loginForm,
    loginBtn,
}) {
    // 按钮：开始/停止监控
    toggleButton.addEventListener("click", () => onToggleClick(toggleButton));

    // 登录表单提交事件
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await onLoginSubmit(loginBtn, loginFormContainer, logoutButton, logContainer);
    });

    // 登出按钮
    logoutButton.addEventListener("click", () => onLogoutClick(logContainer));

    // Popup 被隐藏（关闭）时，通知 Content 脚本
    document.addEventListener("visibilitychange", onPopupVisibilityChange);
}

/** 当用户点下开始/停止按钮时触发 */
function onToggleClick(toggleButton) {
    const action = isRunning ? "stop" : "start";
    sendMessageToContent({ action }, (response) => {
        if (response && typeof response.running === "boolean") {
            isRunning = response.running;
            updateToggleButtonState(toggleButton, isRunning);
        } else {
            console.log("未收到有效的运行状态响应");
        }
    });
}

/** 当用户提交登录表单时触发 */
async function onLoginSubmit(loginBtn, loginFormContainer, logoutButton, logContainer) {
    // 防止重复提交
    loginBtn.disabled = true;

    const username = (document.getElementById("username").value || "").trim();
    const shopname = (document.getElementById("shopname").value || "").trim();
    const messagesPlaceholder = document.getElementById('acr-messages-placeholder');

    showLoginMessage("인증 중입니다...", false);

    try {
        if (!username || !shopname) {
            throw new Error("닉네임과 상호명을 입력해주세요.");
        }

        // 构造 API 请求数据
        const requestData = {
            user_name: username,
            shop_name: shopname,
        };

        // 发起验证请求
        const response = await fetch("https://api.ai-canvas.org/v1/verify_user", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestData),
        });

        if (response.status === 401) {
            throw new Error("입력하신 닉네임+상호명 조합이 존재하지 않습니다.");
        }
        if (response.status === 429) {
            throw new Error("인증요청제한 (3회/1분). 잠시 후 다시 시도해주세요.");
        }

        if (!response.ok) {
            throw new Error("서버 응답 실패");
        }

        const data = await response.json();
        if (!data.api_key) {
            throw new Error("알 수 없는 오류가 발생했습니다.");
        }

        // 登录成功
        isLogin = true;
        showLoginMessage("성공 하였습니다.", false);

        // 保存用户信息到 chrome.storage
        try {
            await saveUserInfoToStorage(data);
        } catch (error) {
            console.log("保存到 chrome.storage 出错:", error);
        }

        // 更新登录状态相关的UI
        await handleLoggedInState(toggleButton, logContainer);

        // 隐藏登录表单
        fadeOutElement(loginFormContainer);

        // 更新登出按钮文本
        logoutButton.textContent = "로그아웃";

        // 更新日志面板
        updateLogContainer(logContainer, []); // 先清理或刷新一次

    } catch (error) {
        console.log("登录验证失败:", error);

        showLoginMessage(error.message, true);

        // alert(error.message);
        loginBtn.disabled = false;
    }
}

/** 当用户点击登出按钮时触发 */
function onLogoutClick(logContainer) {
    const logoutButton = document.getElementById("logout-btn");
    if (logoutButton.textContent === "로그아웃") {
        isLogin = false;

        // 如果在运行中，先停止
        if (isRunning) {
            const toggleButton = document.getElementById("toggleButton");
            toggleButton && toggleButton.click();
        }

        // 清空日志
        logContainer.innerHTML = "";

        // 清空本地存储
        // localStorage.clear();

        // 同时清空 chrome.storage（可选，如果你已经使用 chrome.storage）
        chrome.storage.local.clear(() => {
            if (chrome.runtime.lastError) {
                console.log("清空 chrome.storage 时出错:", chrome.runtime.lastError);
            } 
            
        });

        // 清除 userinfo
        userinfo.user_id = null;
        userinfo.user_name = null;
        userinfo.shop_name = null;
        userinfo.api_key = null;
        userinfo.key_type = null;
        userinfo.expiration_date = null;

        // 通知 content.js 清空用户信息
        sendMessageToContent({ action: "clearUserInfo" });

        // 刷新页面，重置所有UI
        location.reload();
    }
}

/** Popup 关闭时，通知 content.js：popupClosed */
function onPopupVisibilityChange() {
    if (document.hidden && contentTabId) {
        sendMessageToContent({ action: "popupClosed" });
    }
}

/** 处理已登录情况下的一些初始化步骤 */
async function handleLoggedInState(toggleButton, logContainer) {
    // 通知 content.js 用户信息
    sendMessageToContent({ action: "setUserInfo", data: userinfo });

    // 通知 content.js：popup 已打开
    sendMessageToContent({ action: "popupOpened" });

    // 获取 content.js 的运行状态
    sendMessageToContent({ action: "getStatus" }, (response) => {
        if (response && typeof response.running === "boolean") {
            isRunning = response.running;
            updateToggleButtonState(toggleButton, isRunning);
        } else {
            updateToggleButtonState(toggleButton, false);
        }
    });

    // 获取初始日志
    sendMessageToContent({ action: "getLog" }, (response) => {
        if (response && Array.isArray(response.logs)) {
            updateLogContainer(logContainer, response.logs);
        } else {
            console.log("未收到有效日记数据");
        }
    });

    // 监听 Content 脚本的新日记消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "newDiaryEntry" && isLogin) {
            if (isLogin) {
                appendLog(logContainer, message.data);
                sendResponse({ status: "日记已更新" });
            }
        }
    });
}

/** 
 * 通过Promise封装获取当前活动标签页ID 
 * （避免在多个地方回调嵌套）
 */
function getActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError.message);
            }
            if (tabs && tabs.length > 0) {
                resolve(tabs[0]);
            } else {
                reject(new Error("未找到活动标签页"));
            }
        });
    });
}

/** 
 * 向 Content 脚本发送消息的通用函数
 * @param {object} message - { action: string, data?: any }
 * @param {function} [callback] - 回调可选，用于处理异步响应
 */
function sendMessageToContent(message, callback) {
    if (!contentTabId) {
        console.log("未获取到 contentTabId，无法发送消息");
        return;
    }
    chrome.tabs.sendMessage(contentTabId, message, (response) => {
        if (chrome.runtime.lastError) {
            console.log("sendMessage 错误:", chrome.runtime.lastError.message);
            return;
        }
        if (callback) {
            callback(response);
        }
    });
}

/** 更新按钮的外观和文本 */
function updateToggleButtonState(toggleButton, running) {
    toggleButton.textContent = running ? "리뷰모니터링중..." : "리뷰모니터링시작";
    toggleButton.classList.toggle("stop", running);
}

/** 获取并更新日志容器的显示内容 */
function updateLogContainer(logContainer, logs) {
    logContainer.innerHTML = ""; // 先清空
    appendLog(
        logContainer,
        "개발자정보:\n----------------------------------------------\n" +
        "Name: ai-canvas\n" +
        "Mail: m@ai-canvas.org\n" +
        "Site: ai-canvas.org\n" +
        "Blog: blog.ai-canvas.org\n" +
        "---------------------------------------------- "
    );
    appendLog(
        logContainer,
        `사용자정보:\n----------------------------------------------\n` +
        `UserName: ${userinfo.user_name}\n` +
        `ShopName: ${userinfo.shop_name}\n` +
        `API_Key: ${userinfo.api_key}\n` +
        `Key_Type: ${userinfo.key_type}\n` +
        `Expiration_Date: ${userinfo.expiration_date}\n` +
        `---------------------------------------------- `
    );
    if (Array.isArray(logs) && logs.length > 0) {
        logs.forEach((log) => appendLog(logContainer, log));
    }
}

/** 追加单条日志到容器底部 */
function appendLog(logContainer, log) {
    const logEntry = document.createElement("div");
    logEntry.style.marginBottom = "10px";
    logEntry.innerHTML = log.replace(/\n/g, "<br>");
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

/** 从 localStorage 读取用户信息 */
function getUserInfoFromLocal() {
    userinfo.user_id = localStorage.getItem("acr_bm_user_id");
    userinfo.user_name = localStorage.getItem("acr_bm_user_name");
    userinfo.shop_name = localStorage.getItem("acr_bm_shop_name");
    userinfo.api_key = localStorage.getItem("acr_bm_api_key");
    userinfo.key_type = localStorage.getItem("acr_bm_key_type");
    userinfo.expiration_date = localStorage.getItem("acr_bm_expiration_date");
}

/** 保存用户信息到 localStorage */
function saveUserInfoToLocal(data) {
    userinfo.user_id = data.user_id;
    userinfo.user_name = data.user_name;
    userinfo.shop_name = data.shop_name;
    userinfo.api_key = data.api_key;
    userinfo.key_type = data.key_type;
    userinfo.expiration_date = data.expiration_date;

    localStorage.setItem("acr_bm_user_id", data.user_id);
    localStorage.setItem("acr_bm_user_name", data.user_name);
    localStorage.setItem("acr_bm_shop_name", data.shop_name);
    localStorage.setItem("acr_bm_api_key", data.api_key);
    localStorage.setItem("acr_bm_key_type", data.key_type);
    localStorage.setItem("acr_bm_expiration_date", data.expiration_date);
}

/** 更新登录状态相关的UI */
function updateLoginState(loginFormContainer, logoutButton) {
    isLogin = Boolean(userinfo.api_key);
    if (isLogin) {
        loginFormContainer.style.display = "none";
        logoutButton.textContent = "로그아웃";
    } else {
        logoutButton.textContent = "로그인";
    }
}

/** 获取指定ID的DOM元素, 未找到则在控制台报错 */
function getElementOrLogError(id) {
    const el = document.getElementById(id);
    if (!el) {
        console.log(`未找到 DOM 元素: ${id}`);
    }
    return el;
}

/** 给一个元素做简单的淡出动画，结束后隐藏 */
function fadeOutElement(element, duration = 500) {
    element.style.opacity = "1";
    element.style.transition = `opacity ${duration}ms ease-out`;
    element.style.opacity = "0";
    setTimeout(() => {
        element.style.display = "none";
    }, duration);
}

/** 在登陆表单 输出提示内容 */
function showLoginMessage(message, isError = false) {
    const messagesPlaceholder = document.getElementById("acr-messages-placeholder");
    const msg = document.createElement("span");

    msg.innerHTML =  message;
    messagesPlaceholder.innerHTML = "";
    messagesPlaceholder.appendChild(msg);
    
    messagesPlaceholder.className = isError ? "notice notice-error" : "notice notice-noerror";
}