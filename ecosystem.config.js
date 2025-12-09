module.exports = {
    apps: [{
      name: 'alpha7-ia-superpopular',
      script: './app.js', // ou './index.js' ou './app.js' - ajuste conforme seu arquivo principal
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 5000 // ajuste a porta conforme necessário
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }]
  };