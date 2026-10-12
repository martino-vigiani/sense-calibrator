module.exports = {
  apps: [{
    name: 'calib-telemetry',
    script: 'server.js',
    cwd: __dirname,
    max_memory_restart: '150M',
    env: {
      NODE_ENV: 'production',
      PORT: '3040',
      DATA_PATH: '/var/lib/calib-telemetry/sessions.jsonl',
      DATA_V2_PATH: '/var/lib/calib-telemetry/events-v2.jsonl',
      DIAG_DIR: '/var/lib/calib-telemetry/diagnostics',
    },
    merge_logs: true,
    time: true,
  }]
};
