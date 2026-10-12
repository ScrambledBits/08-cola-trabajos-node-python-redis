import json
import os
import re
import signal
import socket
import time
from collections import Counter
from datetime import datetime, timezone

import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
DEMORA_SEGUNDOS = float(os.environ.get("DEMORA_SEGUNDOS", "2"))
NOMBRE = os.environ.get("WORKER_NOMBRE") or socket.gethostname()

# Contrato compartido con la web (ver README).
COLA = "cola:trabajos"
POR_WORKER = "estadisticas:por_worker"

seguir = True


def detener(signum, _frame):
    global seguir
    print(
        f"[{NOMBRE}] Recibida señal {signal.Signals(signum).name}, terminando...",
        flush=True,
    )
    seguir = False


def analizar(texto: str) -> dict:
    palabras = re.findall(r"\w+", texto.lower())
    frecuentes = Counter(p for p in palabras if len(p) > 3).most_common(1)
    return {
        "caracteres": len(texto),
        "palabras": len(palabras),
        "palabras_unicas": len(set(palabras)),
        "palabra_mas_frecuente": frecuentes[0][0] if frecuentes else "",
    }


def main() -> None:
    signal.signal(signal.SIGTERM, detener)
    signal.signal(signal.SIGINT, detener)

    cliente = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    cliente.ping()
    print(f"[{NOMBRE}] Conectado a {REDIS_URL}, esperando trabajos...", flush=True)

    while seguir:
        # Espera bloqueante con timeout para poder revisar 'seguir' periódicamente.
        elemento = cliente.brpop([COLA], timeout=2)
        if elemento is None:
            continue
        _, trabajo_id = elemento
        clave = f"trabajo:{trabajo_id}"
        texto = cliente.hget(clave, "texto") or ""

        cliente.hset(clave, mapping={"estado": "procesando", "worker": NOMBRE})
        print(f"[{NOMBRE}] Procesando {trabajo_id}", flush=True)
        time.sleep(DEMORA_SEGUNDOS)

        cliente.hset(
            clave,
            mapping={
                "estado": "completado",
                "resultado": json.dumps(analizar(texto), ensure_ascii=False),
                "terminado_en": datetime.now(timezone.utc).isoformat(),
            },
        )
        cliente.hincrby(POR_WORKER, NOMBRE, 1)

    print(f"[{NOMBRE}] Adiós.", flush=True)


if __name__ == "__main__":
    main()
