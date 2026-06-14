import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validate } from './app-config.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      skipProcessEnv: true,
      validate: (env: Record<string, string | undefined>) => validate(env),
    }),
  ],
  exports: [NestConfigModule],
})
export class AppConfigModule {}
