import winston from 'winston';

const LOG_FILE = process.env.LOG_FILE || 'bot.log';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
      stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: LOG_FILE }),
  ],
});

export default logger;
