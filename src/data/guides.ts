import type { Guide } from '../engine/guide';
import { BLUE_GUIDES } from './blueGuides';
import { HERO_GUIDES } from './heroGuides';
import { TOON_GUIDES } from './toonGuides';

/** 全デッキのルートガイド */
export const GUIDES: Guide[] = [...TOON_GUIDES, ...BLUE_GUIDES, ...HERO_GUIDES];
