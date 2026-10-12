# Cola de trabajos (Node.js + Python + Redis)

Sistema de **procesamiento en segundo plano** con dos programas escritos en lenguajes distintos que cooperan a través de **Redis**:

- **web** (Node.js + Express): recibe textos desde una página web y los **encola**.
- **worker** (Python): **saca** trabajos de la cola, "analiza" el texto (cuenta palabras y caracteres, busca la palabra más frecuente), simula que tarda unos segundos y guarda el resultado.

La página muestra en tiempo real el estado de cada trabajo y **qué worker** lo procesó, lo que permite ver cómo se reparte la carga al **escalar** los workers.

> Proyecto con fines exclusivamente educativos. Es una versión simplificada del patrón "cola de tareas"; en un sistema real se usarían herramientas especializadas con reintentos, confirmaciones y tolerancia a fallos.

---

## Nivel y objetivos de aprendizaje

**Nivel:** avanzado.

Vas a practicar:

- Dockerizar dos servicios en **lenguajes distintos** dentro del mismo repositorio.
- Un servicio **sin puerto** (el worker no recibe peticiones HTTP: solo consume de Redis).
- **Escalar** un servicio a varias réplicas y observar el reparto de trabajo.
- **Apagado limpio** (*graceful shutdown*): que un worker termine el trabajo en curso antes de detenerse.
- Configurar **límites de recursos** (CPU y memoria) por servicio.
- **Healthchecks** para un proceso que no expone HTTP.

---

## Stack tecnológico

| Componente | Tecnología |
|---|---|
| Web | Node.js 20.19+, Express 5, cliente `redis` (node-redis) |
| Worker | Python 3.12+, cliente `redis` (redis-py) |
| Intermediario | Redis 7 u 8 |
| Interfaz | HTML + JavaScript sin frameworks, refresco cada segundo |

---

## Arquitectura

```
 Navegador ──HTTP──▶ web (Node.js, puerto 3000)
                        │  LPUSH cola:trabajos <id>
                        │  HSET  trabajo:<id> {...}
                        ▼
                     redis ◀──────────────┬──────────────┬──────────────┐
                                          │ BRPOP        │ BRPOP        │ BRPOP
                                     worker #1      worker #2      worker #3  (Python)
```

### Contrato de datos en Redis

Ambos programas deben coincidir en estos nombres de clave (definidos al principio de `web/server.js` y `worker/worker.py`):

| Clave | Tipo | Quién escribe | Contenido |
|---|---|---|---|
| `cola:trabajos` | Lista | web (añade), worker (saca) | IDs de trabajos pendientes. |
| `trabajo:<id>` | Hash | web y worker | `estado` (`pendiente` → `procesando` → `completado`), `texto`, `worker`, `creado_en`, `terminado_en`, `resultado` (JSON). |
| `trabajos:recientes` | Lista | web | Últimos 20 IDs, para la tabla de la página. |
| `estadisticas:por_worker` | Hash | worker | Trabajos completados por cada worker. |

`BRPOP` es una operación **bloqueante** y **atómica**: si varios workers esperan, cada trabajo lo recibe **uno solo**. Por eso escalar los workers funciona sin coordinación adicional.

---

## Estructura del proyecto

```
08-cola-trabajos-node-python-redis/
├── web/
│   ├── server.js          # API REST + archivos estáticos
│   ├── package.json
│   ├── package-lock.json
│   └── public/
│       └── index.html     # Panel con formulario, estadísticas y tabla de trabajos
├── worker/
│   ├── worker.py          # Bucle que consume la cola y procesa trabajos
│   └── requirements.txt
├── README.md
└── CHANGELOG.md
```

Detalles importantes:

- **`web/server.js`**: se conecta a Redis **antes** de escuchar. Maneja `SIGTERM` para cerrar ordenadamente.
- **`worker/worker.py`**
  - El nombre del worker es el **hostname** del contenedor (salvo que definas `WORKER_NOMBRE`). Así, cada réplica aparece con un nombre distinto en el panel.
  - Instala manejadores para `SIGTERM` y `SIGINT`: al recibir la señal **termina el trabajo actual** y luego sale. Espera en la cola con un *timeout* de 2 segundos para poder revisar periódicamente si debe parar.
  - Todos los `print` usan `flush=True`, pero es buena práctica configurar Python para no usar *buffer* en contenedores.
  - **No** expone ningún puerto.

---

## Variables de entorno

### web

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP. |
| `REDIS_URL` | `redis://localhost:6379` | URL de Redis: `redis://[:clave@]host:puerto[/db]`. |

### worker

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | URL de Redis. |
| `DEMORA_SEGUNDOS` | `2` | Tiempo artificial que tarda cada trabajo (para poder observar la cola). |
| `WORKER_NOMBRE` | hostname del contenedor | Nombre con el que se identifica el worker. |

---

## API (web)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Panel web. |
| `GET` | `/health` | `200` si Redis responde; `503` si no. |
| `POST` | `/api/trabajos` | Encola un trabajo. Cuerpo: `{"texto": "..."}`. Responde `202 {"id", "estado"}`. |
| `GET` | `/api/trabajos` | Últimos 20 trabajos con su estado y resultado. |
| `GET` | `/api/trabajos/:id` | Un trabajo; `404` si no existe. |
| `GET` | `/api/estadisticas` | `{"en_cola": n, "procesados_por_worker": {...}}`. |

Ejemplo de resultado de un trabajo completado:

```json
{
  "caracteres": 78,
  "palabras": 10,
  "palabras_unicas": 8,
  "palabra_mas_frecuente": "contenedores"
}
```

---

## Ejecución local sin Docker (referencia)

1. Redis local.
2. **web:** instala dependencias con npm y usa el script `start`.
3. **worker:** entorno virtual de Python, instala `requirements.txt` y ejecuta `worker.py`. Puedes abrir varias terminales para tener varios workers.

---

## Reto: dockerizar la aplicación

> Pistas, no soluciones.

### Parte 1: `web/Dockerfile`

1. Imagen oficial de Node LTS, versión explícita.
2. Dependencias de producción desde el lockfile, aprovechando la caché.
3. Usuario sin privilegios, `NODE_ENV=production`, puerto documentado.
4. Arranque directo del proceso para recibir señales.

### Parte 2: `worker/Dockerfile`

1. Imagen oficial de Python `slim`, versión explícita.
2. Variable de entorno para que la salida de Python **no** use *buffer*.
3. Dependencias primero, código después.
4. Usuario sin privilegios.
5. **No** declares ningún puerto: el worker no los usa.
6. Arranque en forma *exec*. Comprueba la diferencia: con la forma *shell* el proceso de Python no recibe `SIGTERM` y Docker tiene que matarlo a la fuerza tras el tiempo de gracia.

### Parte 3: `docker-compose.yml`

1. Servicios **web**, **worker** y **redis** (imagen oficial, versión explícita).
2. Ambos servicios propios reciben `REDIS_URL` con el nombre del servicio de Redis.
3. Healthcheck para Redis; web y worker esperan a que esté sano.
4. **Escala** el worker a 3 réplicas desde la línea de comandos y, después, de forma **declarativa** dentro del archivo (busca la opción de réplicas en la sección de despliegue).
5. ¡Ojo! Si le pones un **nombre de contenedor fijo** al worker, no podrás escalarlo. ¿Por qué?
6. **Límites de recursos:** limita la memoria y la CPU del worker. Observa el consumo con la herramienta de estadísticas de Docker.
7. **Tiempo de gracia:** sube `DEMORA_SEGUNDOS` a 15, encola trabajos y detén el entorno. ¿Qué pasa con el trabajo en curso? Investiga la opción que controla cuánto espera Docker entre `SIGTERM` y `SIGKILL`, y ajústala.
8. **Healthcheck del worker:** no hay HTTP. Piensa en alternativas: comprobar que el proceso existe, o que Redis es alcanzable desde el worker usando Python (que ya está en la imagen).
9. Persistencia de Redis: ¿la necesitas aquí? Discute qué se pierde si Redis se reinicia sin volumen.

### Criterios de aceptación

- [ ] Al pulsar "Encolar 10 de ejemplo", los trabajos pasan de `pendiente` a `procesando` a `completado`.
- [ ] Con 3 workers, el panel muestra **3 nombres distintos** y el trabajo se reparte entre ellos.
- [ ] Con 3 workers, 10 trabajos tardan bastante menos que con 1 worker.
- [ ] Al detener el entorno, los workers terminan **sin** ser forzados (sale "Adiós." en sus logs).
- [ ] Solo la web publica un puerto.
- [ ] Los límites de recursos del worker aparecen aplicados en las estadísticas de Docker.

### Retos extra

- Agrega **RedisInsight** (interfaz gráfica oficial de Redis) como servicio opcional mediante un **perfil**, y observa las claves en vivo.
- Protege Redis con contraseña y ajusta `REDIS_URL` en ambos servicios.
- Construye las dos imágenes con un único comando de construcción usando **Bake** de Docker.
- Escribe un segundo tipo de worker (por ejemplo, en Go) que consuma la misma cola, demostrando que el contrato de Redis es independiente del lenguaje.

---

## Errores comunes

| Síntoma | Causa probable |
|---|---|
| `ECONNREFUSED 127.0.0.1:6379` en la web, o `Connection refused` en el worker | `REDIS_URL` no definida o con `localhost`. |
| Los trabajos se quedan en `pendiente` | No hay workers corriendo, o están conectados a otro Redis. |
| Todos los trabajos los procesa el mismo worker | Solo hay una réplica, o no se escaló el servicio correcto. |
| No ves los logs del worker | Salida de Python con *buffer*. |
| `docker compose down` tarda ~10 s | El worker no recibe `SIGTERM` (forma *shell*) y es matado al expirar el tiempo de gracia. |
| Error al escalar: el nombre ya está en uso | Definiste un nombre de contenedor fijo para un servicio escalado. |

---

## Referencias

- Patrón de cola fiable con listas de Redis: <https://redis.io/docs/latest/develop/data-types/lists/>
- Comando `BRPOP`: <https://redis.io/docs/latest/commands/brpop/>
- node-redis: <https://github.com/redis/node-redis>
- redis-py: <https://redis.readthedocs.io/>
- Despliegue y recursos en Compose: <https://docs.docker.com/reference/compose-file/deploy/>
- Referencia de servicios en Compose: <https://docs.docker.com/reference/compose-file/services/>
- Docker Bake: <https://docs.docker.com/build/bake/>
