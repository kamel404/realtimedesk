import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Every route starts with /api, e.g. GET /api/tickets
  app.setGlobalPrefix('api');

  // Allow the Next.js frontend (another origin) to call this API.
  app.enableCors({ origin: config.get<string>('FRONTEND_URL') });

  await app.listen(config.get<number>('PORT') ?? 4000);
}
await bootstrap();
