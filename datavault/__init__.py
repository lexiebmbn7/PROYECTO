"""Núcleo modular de DataVault DLP.

Los routers y flujos históricos siguen en ``main.py`` por compatibilidad, pero
configuración, estados, resiliencia, outbox, procesamiento y reportes viven
separados para reducir acoplamiento y facilitar las pruebas finales.
"""

__version__ = "39.44"
