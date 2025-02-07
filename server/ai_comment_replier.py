import tenacity
import itertools
import asyncio
import httpx
import secrets
from datetime import datetime, timedelta
from typing import AsyncGenerator, List, Dict, Optional
import logging

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import Column, String, Integer, DateTime, select

from fastapi_limiter import FastAPILimiter
from fastapi_limiter.depends import RateLimiter
from redis.asyncio import Redis

# -----------------------------
# 1. 日志 & FastAPI 初始化
# -----------------------------
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许的前端域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# 2. 数据库配置
# -----------------------------
DATABASE_URL = "mysql+aiomysql://db_user:db_pass@localhost/ai_comment_replier"

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_size=20,
    max_overflow=10,
    pool_recycle=1800,
    pool_pre_ping=True
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    autoflush=False
)

Base = declarative_base()

# -----------------------------
# 3. 业务常量
# -----------------------------
OPENAI_API_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_MAX_TOKENS = 150

MONTHLY_LIMIT_DEMO = 10
MONTHLY_LIMIT_LITE = 1000
MONTHLY_LIMIT_PRO = 10000

# -----------------------------
# 4. 数据库模型
# -----------------------------
class OpenAIKey(Base):
    __tablename__ = "openai_keys"
    id = Column(Integer, primary_key=True, index=True)
    api_key = Column(String(255), unique=True, nullable=False)

class ClientKey(Base):
    __tablename__ = "client_keys"
    id = Column(Integer, primary_key=True, index=True)
    client_name = Column(String(255), nullable=True)
    shop_name = Column(String(255), nullable=True)
    client_key = Column(String(255), unique=True, nullable=False)
    remaining_uses = Column(Integer, default=MONTHLY_LIMIT_DEMO)
    last_reset = Column(DateTime, default=datetime.now)
    expiration_date = Column(DateTime, nullable=True)
    key_type = Column(String(50), default="demo")
    user_pass = Column(String(255), nullable=True)

# -----------------------------
# 5. 启动事件：初始化数据库 & 载入OpenAIKeys
# -----------------------------
@app.on_event("startup")
async def on_startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await load_openai_keys()

    redis = Redis(host="localhost", port=6379, db=0)
    await FastAPILimiter.init(redis)

# -----------------------------
# 6. 轮询 OpenAI Key
# -----------------------------
api_keys_cycle = None
api_keys_lock = asyncio.Lock()  # 添加锁

async def load_openai_keys():
    global api_keys_cycle
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(OpenAIKey.api_key))
        rows = result.scalars().all()
        if not rows:
            logger.warning("No OpenAIKey records found in openai_keys table.")
        async with api_keys_lock:
            api_keys_cycle = itertools.cycle(rows)

async def get_next_api_key():
    async with api_keys_lock:
        if not api_keys_cycle:
            return None
        return next(api_keys_cycle)

# -----------------------------
# 7. Pydantic 模型
# -----------------------------
class OpenAIRequest(BaseModel):
    messages: List[Dict]

class VerifyUserRequest(BaseModel):
    user_name: str
    shop_name: str

# -----------------------------
# 8. 获取异步会话的依赖
# -----------------------------
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session

# -----------------------------
# 9. 动态超时与重试机制
# -----------------------------
INITIAL_TIMEOUT = 60
MAX_TIMEOUT = 120
TIMEOUT_INCREMENT = 10
RETRY_MAX_ATTEMPTS = 3
RETRY_WAIT_SECONDS = 2

# @tenacity.retry(
#     stop=tenacity.stop_after_attempt(RETRY_MAX_ATTEMPTS),
#     wait=tenacity.wait_fixed(RETRY_WAIT_SECONDS),
#     retry=tenacity.retry_if_exception_type(httpx.RequestError),
# )
async def call_openai_api(
    url: str,
    headers: Dict[str, str],
    payload: Dict,
    timeout: int
) -> Optional[Dict]:
    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            headers=headers,
            json=payload,
            timeout=timeout
        )
        response.raise_for_status()
        return response.json()

# -----------------------------
# 10. 路由：代理到 OpenAI /chat/completions
# -----------------------------
@app.post("/v1/chat/completions", dependencies=[Depends(RateLimiter(times=20, seconds=60))])
async def proxy_openai(
    request: OpenAIRequest,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db)
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    client_key = authorization
    result = await db.execute(select(ClientKey).where(ClientKey.client_key == client_key))
    client_record = result.scalar_one_or_none()
    current_date = datetime.now()

    if not client_record:
        raise HTTPException(status_code=401, detail="유효하지 않은 클라이언트 키")

    if client_record.expiration_date and client_record.expiration_date < current_date:
        raise HTTPException(status_code=403, detail="클라이언트 API 키가 만료되었습니다")

    # 判断当月使用限制，并在必要时重置调用次数
    if client_record.key_type == "pro":
        monthly_limit = MONTHLY_LIMIT_PRO
    elif client_record.key_type == "lite":
        monthly_limit = MONTHLY_LIMIT_LITE
    else:
        monthly_limit = MONTHLY_LIMIT_DEMO

    if (
        client_record.last_reset.month != current_date.month
        or client_record.last_reset.year != current_date.year
    ):
        client_record.remaining_uses = monthly_limit
        client_record.last_reset = current_date

    if client_record.remaining_uses <= 0:
        raise HTTPException(status_code=403, detail="클라이언트 API 키 월사용 한도를 초과했습니다")

    # 1. 轮询获取 OpenAI API Key
    selected_api_key = await get_next_api_key()
    if not selected_api_key:
        raise HTTPException(status_code=500, detail="No available OpenAI API key.")

    # 2. 获取 OpenAI API Key 成功后，扣减一次调用次数并提交
    client_record.remaining_uses -= 1
    db.add(client_record)
    await db.commit()

    headers = {
        "Authorization": f"Bearer {selected_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": DEFAULT_MODEL,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "messages": request.messages,
    }

    timeout = INITIAL_TIMEOUT
    for attempt in range(RETRY_MAX_ATTEMPTS):
        try:
            response = await call_openai_api(
                f"{OPENAI_API_URL}/chat/completions",
                headers=headers,
                payload=payload,
                timeout=timeout
            )
            return response
        except httpx.RequestError as e:
            logger.warning(f"Attempt {attempt + 1} failed: {e}")
            timeout = min(timeout + TIMEOUT_INCREMENT, MAX_TIMEOUT)
            if attempt == RETRY_MAX_ATTEMPTS - 1:
                # 重试失败后补偿性恢复调用次数
                client_record.remaining_uses += 1
                db.add(client_record)
                await db.commit()
                raise HTTPException(status_code=500, detail="OpenAI API request failed after retries")

# -----------------------------
# 11. 返回前端要用的选择器 JSON
# -----------------------------
# 更新于 2025/02/07
SELECTORS_DATA = {
    "popup_modal": "section.bsds-modal.bsds-callout.PopupGuide-module__YXQS",
    "popup_close_button": "button[aria-label='닫기']",
    "chatbot_modal": ".ChatRoom-module__s39G.ChatRoom-module__RLLI",
    "chatbot_close_button": "button[aria-label='챗봇 닫기']",
    "review_management_button": 'div[data-atelier-component="Flex"]',
    "review_management_button_text": "리뷰관리",
    "select_dropdown": ".Select-module__a623.ShopSelect-module___pC1",
    "review_list": ".review-list",
    "review_card": ".Card.self-ds",
    "nickname": ".nick",
    "review_content": ".review-cont",
    "reply_button": "button",
    "reply_button_text": "사장님 댓글 등록하기",
    "reply_input": "textarea.TextArea_b_9yfm_12i8sxie",
    "confirm_button": "button[data-disabled='false']",
    "confirm_button_text": "등록",
    "rating_stars": ".rating-stars svg path",
    "rating_star_filled": "#FFC600",
    "menu_item": "li.MenuItem-module__gKDi span.Badge_b_9yfm_19agxism",
    "rider_comments": ".ReviewDelivery-module__ocSi .Flex_c_9rpk_bbdidai span.Badge_b_9yfm_19agxism"
}

@app.get("/v1/selectors", dependencies=[Depends(RateLimiter(times=10, seconds=60))])
async def get_selectors(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    client_key = authorization

    result = await db.execute(
        select(ClientKey).where(ClientKey.client_key == client_key)
    )
    client_record = result.scalar_one_or_none()
    current_date = datetime.now()

    if not client_record:
        raise HTTPException(status_code=401, detail="유효하지 않은 클라이언트 키")

    if client_record.expiration_date and client_record.expiration_date < current_date:
        raise HTTPException(status_code=403, detail="클라이언트 API 키가 만료되었습니다")

    return SELECTORS_DATA

# -----------------------------
# 12. 验证账户接口
# -----------------------------
@app.post("/v1/verify_user", dependencies=[Depends(RateLimiter(times=3, seconds=60))])
async def verify_user(
    req: VerifyUserRequest,
    db: AsyncSession = Depends(get_db)
):
    # 1. 查询是否已存在记录
    stmt = select(ClientKey).where(ClientKey.client_name == req.user_name)

    result = await db.execute(stmt)
    existing_record = result.scalars().first()

    if existing_record:
        # **如果 shop_name 匹配，则视为登录成功**
        if existing_record.shop_name == req.shop_name:
            return {
                "user_id": existing_record.id,
                "user_name": existing_record.client_name,
                "shop_name": existing_record.shop_name,
                "api_key": existing_record.client_key,
                "key_type": existing_record.key_type,
                "expiration_date": existing_record.expiration_date
            }
        else:
            # **用户名存在，但商户不匹配**
            raise HTTPException(status_code=401, detail="닉네임+상호명 조합이존재하지 않습니다")


    # 3. 不存在则创建新账户
    one_month_later = datetime.now() + timedelta(days=30)
    random_str = secrets.token_hex(16)  # 32位随机hex字符串
    new_api_key = f"api_key_{req.user_name}_{random_str}"

    new_user = ClientKey(
        client_name=req.user_name,
        shop_name=req.shop_name,
        client_key=new_api_key,
        key_type="demo",
        expiration_date=one_month_later,
        remaining_uses=MONTHLY_LIMIT_DEMO,
        last_reset=datetime.now()
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)  # 刷新获取新记录ID

    return {
        "user_id": new_user.id,
        "user_name": new_user.client_name,
        "shop_name": new_user.shop_name,
        "api_key": new_user.client_key,
        "key_type": new_user.key_type,
        "expiration_date": new_user.expiration_date
    }

# -----------------------------
# 13. 全局异常处理器
# -----------------------------
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # 将详细异常信息输出到控制台
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    # 统一返回 Internal server error
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"}
    )
