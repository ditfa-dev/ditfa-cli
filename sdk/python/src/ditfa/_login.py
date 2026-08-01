from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .async_client import AsyncDitfaClient
from .client import DitfaClient
from .generated.v2_all import (
    AccountLoginCompletedNotification,
    CancelLoginAccountResponse,
    ChatgptDeviceCodeLoginAccountParams,
    ChatgptDeviceCodeLoginAccountResponse,
    ChatgptLoginAccountParams,
    ChatgptLoginAccountResponse,
    LoginAccountParams,
)


class _AsyncLoginOwner(Protocol):
    """Subset of AsyncDitfa needed by async login handles."""

    _client: AsyncDitfaClient

    async def _ensure_initialized(self) -> None:
        """Ensure the owning SDK client has a live Ditfa connection."""
        ...


def start_chatgpt_login(client: DitfaClient) -> ChatgptLoginHandle:
    """Start browser ChatGPT login and return the handle for that attempt."""
    response = client.account_login_start(
        LoginAccountParams(
            root=ChatgptLoginAccountParams(type="chatgpt"),
        )
    )
    response_root = response.root
    if not isinstance(response_root, ChatgptLoginAccountResponse):
        raise RuntimeError(f"unexpected ChatGPT login response: {response_root!r}")
    return ChatgptLoginHandle(
        client,
        response_root.login_id,
        response_root.auth_url,
    )


async def async_start_chatgpt_login(owner: _AsyncLoginOwner) -> AsyncChatgptLoginHandle:
    """Start async browser ChatGPT login and return that attempt's handle."""
    response = await owner._client.account_login_start(
        LoginAccountParams(
            root=ChatgptLoginAccountParams(type="chatgpt"),
        )
    )
    response_root = response.root
    if not isinstance(response_root, ChatgptLoginAccountResponse):
        raise RuntimeError(f"unexpected ChatGPT login response: {response_root!r}")
    return AsyncChatgptLoginHandle(
        owner,
        response_root.login_id,
        response_root.auth_url,
    )


def start_device_code_login(client: DitfaClient) -> DeviceCodeLoginHandle:
    """Start device-code ChatGPT login and return the handle for that attempt."""
    response = client.account_login_start(
        LoginAccountParams(
            root=ChatgptDeviceCodeLoginAccountParams(type="chatgptDeviceCode"),
        )
    )
    response_root = response.root
    if not isinstance(response_root, ChatgptDeviceCodeLoginAccountResponse):
        raise RuntimeError(f"unexpected device-code login response: {response_root!r}")
    return DeviceCodeLoginHandle(
        client,
        response_root.login_id,
        response_root.verification_url,
        response_root.user_code,
    )


async def async_start_device_code_login(
    owner: _AsyncLoginOwner,
) -> AsyncDeviceCodeLoginHandle:
    """Start async device-code ChatGPT login and return that attempt's handle."""
    response = await owner._client.account_login_start(
        LoginAccountParams(
            root=ChatgptDeviceCodeLoginAccountParams(type="chatgptDeviceCode"),
        )
    )
    response_root = response.root
    if not isinstance(response_root, ChatgptDeviceCodeLoginAccountResponse):
        raise RuntimeError(f"unexpected device-code login response: {response_root!r}")
    return AsyncDeviceCodeLoginHandle(
        owner,
        response_root.login_id,
        response_root.verification_url,
        response_root.user_code,
    )


@dataclass(slots=True)
class ChatgptLoginHandle:
    """Live browser-login attempt returned by `Ditfa.login_chatgpt()`."""

    _client: DitfaClient
    login_id: str
    auth_url: str

    def wait(self) -> AccountLoginCompletedNotification:
        """Wait for this browser login attempt's completion notification."""
        return self._client.wait_for_login_completed(self.login_id)

    def cancel(self) -> CancelLoginAccountResponse:
        """Cancel this browser login attempt."""
        return self._client.account_login_cancel(self.login_id)


@dataclass(slots=True)
class DeviceCodeLoginHandle:
    """Live device-code login attempt returned by `Ditfa.login_chatgpt_device_code()`."""

    _client: DitfaClient
    login_id: str
    verification_url: str
    user_code: str

    def wait(self) -> AccountLoginCompletedNotification:
        """Wait for this device-code login attempt's completion notification."""
        return self._client.wait_for_login_completed(self.login_id)

    def cancel(self) -> CancelLoginAccountResponse:
        """Cancel this device-code login attempt."""
        return self._client.account_login_cancel(self.login_id)


@dataclass(slots=True)
class AsyncChatgptLoginHandle:
    """Live browser-login attempt returned by `AsyncDitfa.login_chatgpt()`."""

    _ditfa: _AsyncLoginOwner
    login_id: str
    auth_url: str

    async def wait(self) -> AccountLoginCompletedNotification:
        """Wait for this browser login attempt's completion notification."""
        await self._ditfa._ensure_initialized()
        return await self._ditfa._client.wait_for_login_completed(self.login_id)

    async def cancel(self) -> CancelLoginAccountResponse:
        """Cancel this browser login attempt."""
        await self._ditfa._ensure_initialized()
        return await self._ditfa._client.account_login_cancel(self.login_id)


@dataclass(slots=True)
class AsyncDeviceCodeLoginHandle:
    """Live device-code attempt returned by `AsyncDitfa.login_chatgpt_device_code()`."""

    _ditfa: _AsyncLoginOwner
    login_id: str
    verification_url: str
    user_code: str

    async def wait(self) -> AccountLoginCompletedNotification:
        """Wait for this device-code login attempt's completion notification."""
        await self._ditfa._ensure_initialized()
        return await self._ditfa._client.wait_for_login_completed(self.login_id)

    async def cancel(self) -> CancelLoginAccountResponse:
        """Cancel this device-code login attempt."""
        await self._ditfa._ensure_initialized()
        return await self._ditfa._client.account_login_cancel(self.login_id)
