"""The iPhone, iPad and Mac app's pairing and devices (NOTES-24): the routes of the module geraete
(``vendor/nexgeraete``), the same in every nex app, over nexnotes' tables (``services/geraete_store.py``).

Browser (``/api``, sessions only; a device's key hears ``403 browser_only``): ``/app-pairing`` (QR code and the code to
type, AC-1), ``/app-connect`` (the page the app opens to sign in, AC-2), ``/app-devices`` (list, rename, disconnect,
the kinds of notification per device, AC-5), ``/server/accounts/{id}/devices`` (the operator, G28).

App (``/api/app/1``): ``pairing/{id}/key``, ``pairing/code``, ``devices`` (iCloud, AC-7; the list), ``device``,
``push`` and ``push/kinds``. A request without ``X-Nex-App`` is answered in the form the published app knows (``nex``,
nexnotes' own). The app's other routes (``hello``, ``me``, ``changes`` …) are in ``routers/app1*.py``; they take the
module's check of a key (``app1.device``).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.routing import APIRoute

from ..db import SessionLocal
from ..deps import client_ip, require_account, require_operator
from ..services import geraete_store, settings_service
from ..services.geraete_config import CONFIG, clock
from ..vendor.nexgeraete import CLIENT_HEADER, Caller, api, devices
from ..vendor.nexgeraete.model import Device, Holder, Store

# The pickups count at the sign-in brake of konten (G37, pot ``app-pairing:<sender>``); ``security.brake.forget``
# resets it too.
from ..vendor.nexkonten.brake import BRAKE


def _address(_request: Request) -> str:
    """The public address from the settings wins: whoever opens nexnotes at home by its IP address still wants the app
    to know the one that works on the way."""
    with SessionLocal() as db:
        return settings_service.public_url(db)


def _on_paired(holder: Holder, device: Device) -> None:
    geraete_store.on_paired(holder, device)


#: The operationIds these routes had in /api/openapi.json before the module (E53); the summaries are the module's.
OPERATION_IDS = {
    ("DELETE", "/api/app/1/device"): "forget_device_api_app_1_device_delete",
    ("DELETE", "/api/app/1/devices/{device_id}"): "disconnect_device_api_app_1_devices__device_id__delete",
    ("POST", "/api/app/1/pairing/code"): "pickup_by_code_api_app_1_pairing_code_post",
    ("POST", "/api/app/1/pairing/{pairing_id}/key"): "pickup_by_secret_api_app_1_pairing__pairing_id__key_post",
}
#: The list of the app's devices is nexnotes' own route below (the order of the published app).
OWN = ("GET", "/api/app/1/devices")

router = APIRouter()

_device = api.device(config=CONFIG, store=geraete_store.store, clock=clock.now)


@router.get("/api/app/1/devices", response_model=None, tags=["app"], summary="The account's devices, this one marked",
            operation_id="own_devices_api_app_1_devices_get")
def own_devices(request: Request, found: Annotated[Caller, Depends(_device)],
                data: Annotated[Store, Depends(geraete_store.store)]) -> Any:
    """The module's list. The published app (no ``X-Nex-App``) gets it in the order it knows, oldest first; an app
    built on the module newest first, as everywhere."""
    listed = devices.listing(data, CONFIG, found.holder.id, this=found.device.id)
    if request.headers.get(CLIENT_HEADER):
        return listed
    return sorted(listed, key=lambda entry: entry["id"])


def _tidy(routes: APIRouter) -> APIRouter:
    """The module's own list of the app's devices gives way to nexnotes' (``own_devices`` above); the routes of
    before keep their operationIds."""
    kept = []
    for route in routes.routes:
        if isinstance(route, APIRoute):
            keys = {(method, route.path) for method in route.methods}
            if OWN in keys:
                continue
            for key in keys & OPERATION_IDS.keys():
                route.operation_id = OPERATION_IDS[key]
        kept.append(route)
    routes.routes[:] = kept
    return routes


router.include_router(api.browser_router(
    config=CONFIG, store=geraete_store.store, account=require_account, operator=require_operator,
    address=_address, send=lambda url, body: geraete_store.send(url, body), clock=clock.now,
))
router.include_router(_tidy(api.app_router(
    config=CONFIG, store=geraete_store.store, brake=BRAKE, on_paired=_on_paired, sender=client_ip,
    send=lambda url, body: geraete_store.send(url, body), clock=clock.now,
)))
