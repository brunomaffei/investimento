/**
 * Utilidades dos testes: sobe o servidor do app numa porta livre e confirma que
 * ele responde. Porta fixa conflitava com processo de execução anterior e o teste
 * seguia contra um servidor morto, falhando longe da causa real.
 */
import { spawn } from 'node:child_process';

const RAIZ = new URL('..', import.meta.url).pathname;

export async function subirServidor(argumentos = [], ambiente = {}) {
  const processo = spawn(process.execPath, ['tools/servidor.mjs', '--porta', '0', ...argumentos], {
    cwd: RAIZ,
    env: { ...process.env, ...ambiente },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  processo.stdout.on('data', (d) => log.push(String(d)));
  processo.stderr.on('data', (d) => log.push(String(d)));

  const porta = await new Promise((resolve, reject) => {
    const limite = setTimeout(
      () => reject(new Error(`servidor não anunciou a porta. Saída:\n${log.join('')}`)),
      10000,
    );
    const procurar = () => {
      const achado = log.join('').match(/http:\/\/localhost:(\d+)/);
      if (achado) {
        clearTimeout(limite);
        resolve(Number(achado[1]));
      }
    };
    processo.stdout.on('data', procurar);
    processo.on('exit', (codigo) => {
      clearTimeout(limite);
      reject(new Error(`servidor saiu com código ${codigo}. Saída:\n${log.join('')}`));
    });
    procurar();
  });

  // Confirma que atende de verdade: sem isso, servidor morto viraria falha difusa
  // ("o navegador bloqueou a chamada") em vez de erro claro aqui.
  for (let tentativa = 0; tentativa < 60; tentativa++) {
    try {
      const resposta = await fetch(`http://127.0.0.1:${porta}/api/health`);
      if (resposta.ok) return { porta, processo, log, base: `http://127.0.0.1:${porta}` };
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  processo.kill();
  throw new Error(`servidor na porta ${porta} não respondeu /api/health. Saída:\n${log.join('')}`);
}
