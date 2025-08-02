import pino from 'pino';

export const logger = pino(
  {
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ sync: false }),
);

export default logger;
