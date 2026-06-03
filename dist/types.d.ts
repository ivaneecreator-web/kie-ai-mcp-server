import { z } from "zod";
export declare const NanoBananaImageSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodOptional<z.ZodString>;
    image_input: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    output_format: z.ZodOptional<z.ZodDefault<z.ZodEnum<["png", "jpg"]>>>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9", "auto"]>>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1K", "2K", "4K"]>>>;
    google_search: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    prompt?: string | undefined;
    image_input?: string[] | undefined;
    output_format?: "png" | "jpg" | undefined;
    aspect_ratio?: "1:1" | "1:4" | "1:8" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "8:1" | "9:16" | "16:9" | "21:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    google_search?: boolean | undefined;
}, {
    prompt?: string | undefined;
    image_input?: string[] | undefined;
    output_format?: "png" | "jpg" | undefined;
    aspect_ratio?: "1:1" | "1:4" | "1:8" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "8:1" | "9:16" | "16:9" | "21:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    google_search?: boolean | undefined;
}>, {
    prompt?: string | undefined;
    image_input?: string[] | undefined;
    output_format?: "png" | "jpg" | undefined;
    aspect_ratio?: "1:1" | "1:4" | "1:8" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "8:1" | "9:16" | "16:9" | "21:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    google_search?: boolean | undefined;
}, {
    prompt?: string | undefined;
    image_input?: string[] | undefined;
    output_format?: "png" | "jpg" | undefined;
    aspect_ratio?: "1:1" | "1:4" | "1:8" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "8:1" | "9:16" | "16:9" | "21:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    google_search?: boolean | undefined;
}>;
export declare const Veo3GenerateSchema: z.ZodObject<{
    prompt: z.ZodString;
    imageUrls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    model: z.ZodDefault<z.ZodEnum<["veo3", "veo3_fast"]>>;
    watermark: z.ZodOptional<z.ZodString>;
    aspectRatio: z.ZodDefault<z.ZodEnum<["16:9", "9:16", "Auto"]>>;
    seeds: z.ZodOptional<z.ZodNumber>;
    callBackUrl: z.ZodOptional<z.ZodString>;
    enableFallback: z.ZodDefault<z.ZodBoolean>;
    enableTranslation: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    model: "veo3" | "veo3_fast";
    aspectRatio: "9:16" | "16:9" | "Auto";
    enableFallback: boolean;
    imageUrls?: string[] | undefined;
    watermark?: string | undefined;
    seeds?: number | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
}, {
    prompt: string;
    imageUrls?: string[] | undefined;
    model?: "veo3" | "veo3_fast" | undefined;
    watermark?: string | undefined;
    aspectRatio?: "9:16" | "16:9" | "Auto" | undefined;
    seeds?: number | undefined;
    callBackUrl?: string | undefined;
    enableFallback?: boolean | undefined;
    enableTranslation?: boolean | undefined;
}>;
export declare const SunoGenerateSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    customMode: z.ZodBoolean;
    instrumental: z.ZodBoolean;
    model: z.ZodOptional<z.ZodDefault<z.ZodEnum<["V3_5", "V4", "V4_5", "V4_5PLUS", "V5"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
    style: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    negativeTags: z.ZodOptional<z.ZodString>;
    vocalGender: z.ZodOptional<z.ZodEnum<["m", "f"]>>;
    styleWeight: z.ZodOptional<z.ZodNumber>;
    weirdnessConstraint: z.ZodOptional<z.ZodNumber>;
    audioWeight: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    customMode: boolean;
    instrumental: boolean;
    model?: "V3_5" | "V4" | "V4_5" | "V4_5PLUS" | "V5" | undefined;
    callBackUrl?: string | undefined;
    style?: string | undefined;
    title?: string | undefined;
    negativeTags?: string | undefined;
    vocalGender?: "m" | "f" | undefined;
    styleWeight?: number | undefined;
    weirdnessConstraint?: number | undefined;
    audioWeight?: number | undefined;
}, {
    prompt: string;
    customMode: boolean;
    instrumental: boolean;
    model?: "V3_5" | "V4" | "V4_5" | "V4_5PLUS" | "V5" | undefined;
    callBackUrl?: string | undefined;
    style?: string | undefined;
    title?: string | undefined;
    negativeTags?: string | undefined;
    vocalGender?: "m" | "f" | undefined;
    styleWeight?: number | undefined;
    weirdnessConstraint?: number | undefined;
    audioWeight?: number | undefined;
}>, {
    prompt: string;
    customMode: boolean;
    instrumental: boolean;
    model?: "V3_5" | "V4" | "V4_5" | "V4_5PLUS" | "V5" | undefined;
    callBackUrl?: string | undefined;
    style?: string | undefined;
    title?: string | undefined;
    negativeTags?: string | undefined;
    vocalGender?: "m" | "f" | undefined;
    styleWeight?: number | undefined;
    weirdnessConstraint?: number | undefined;
    audioWeight?: number | undefined;
}, {
    prompt: string;
    customMode: boolean;
    instrumental: boolean;
    model?: "V3_5" | "V4" | "V4_5" | "V4_5PLUS" | "V5" | undefined;
    callBackUrl?: string | undefined;
    style?: string | undefined;
    title?: string | undefined;
    negativeTags?: string | undefined;
    vocalGender?: "m" | "f" | undefined;
    styleWeight?: number | undefined;
    weirdnessConstraint?: number | undefined;
    audioWeight?: number | undefined;
}>;
export declare const ElevenLabsTTSSchema: z.ZodObject<{
    text: z.ZodString;
    model: z.ZodOptional<z.ZodDefault<z.ZodEnum<["turbo", "multilingual"]>>>;
    voice: z.ZodOptional<z.ZodDefault<z.ZodEnum<["Rachel", "Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River", "Liam", "Charlotte", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Bill"]>>>;
    stability: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    similarity_boost: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    style: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    speed: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    timestamps: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    previous_text: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    next_text: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    language_code: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    model?: "turbo" | "multilingual" | undefined;
    callBackUrl?: string | undefined;
    style?: number | undefined;
    voice?: "Rachel" | "Aria" | "Roger" | "Sarah" | "Laura" | "Charlie" | "George" | "Callum" | "River" | "Liam" | "Charlotte" | "Alice" | "Matilda" | "Will" | "Jessica" | "Eric" | "Chris" | "Brian" | "Daniel" | "Lily" | "Bill" | undefined;
    stability?: number | undefined;
    similarity_boost?: number | undefined;
    speed?: number | undefined;
    timestamps?: boolean | undefined;
    previous_text?: string | undefined;
    next_text?: string | undefined;
    language_code?: string | undefined;
}, {
    text: string;
    model?: "turbo" | "multilingual" | undefined;
    callBackUrl?: string | undefined;
    style?: number | undefined;
    voice?: "Rachel" | "Aria" | "Roger" | "Sarah" | "Laura" | "Charlie" | "George" | "Callum" | "River" | "Liam" | "Charlotte" | "Alice" | "Matilda" | "Will" | "Jessica" | "Eric" | "Chris" | "Brian" | "Daniel" | "Lily" | "Bill" | undefined;
    stability?: number | undefined;
    similarity_boost?: number | undefined;
    speed?: number | undefined;
    timestamps?: boolean | undefined;
    previous_text?: string | undefined;
    next_text?: string | undefined;
    language_code?: string | undefined;
}>;
export declare const ElevenLabsSoundEffectsSchema: z.ZodObject<{
    text: z.ZodString;
    loop: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    duration_seconds: z.ZodOptional<z.ZodNumber>;
    prompt_influence: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    output_format: z.ZodOptional<z.ZodDefault<z.ZodEnum<["mp3_22050_32", "mp3_44100_32", "mp3_44100_64", "mp3_44100_96", "mp3_44100_128", "mp3_44100_192", "pcm_8000", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100", "pcm_48000", "ulaw_8000", "alaw_8000", "opus_48000_32", "opus_48000_64", "opus_48000_96", "opus_48000_128", "opus_48000_192"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    output_format?: "mp3_22050_32" | "mp3_44100_32" | "mp3_44100_64" | "mp3_44100_96" | "mp3_44100_128" | "mp3_44100_192" | "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_44100" | "pcm_48000" | "ulaw_8000" | "alaw_8000" | "opus_48000_32" | "opus_48000_64" | "opus_48000_96" | "opus_48000_128" | "opus_48000_192" | undefined;
    callBackUrl?: string | undefined;
    loop?: boolean | undefined;
    duration_seconds?: number | undefined;
    prompt_influence?: number | undefined;
}, {
    text: string;
    output_format?: "mp3_22050_32" | "mp3_44100_32" | "mp3_44100_64" | "mp3_44100_96" | "mp3_44100_128" | "mp3_44100_192" | "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_44100" | "pcm_48000" | "ulaw_8000" | "alaw_8000" | "opus_48000_32" | "opus_48000_64" | "opus_48000_96" | "opus_48000_128" | "opus_48000_192" | undefined;
    callBackUrl?: string | undefined;
    loop?: boolean | undefined;
    duration_seconds?: number | undefined;
    prompt_influence?: number | undefined;
}>;
export declare const ByteDanceSeedanceVideoSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["standard", "fast"]>>>;
    first_frame_url: z.ZodOptional<z.ZodString>;
    last_frame_url: z.ZodOptional<z.ZodString>;
    reference_image_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reference_video_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reference_audio_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1:1", "9:16", "16:9", "4:3", "3:4", "21:9", "9:21", "adaptive"]>>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["480p", "720p"]>>>;
    duration: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    generate_audio: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    web_search: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    nsfw_checker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | "9:21" | "adaptive" | undefined;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "standard" | "fast" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    reference_image_urls?: string[] | undefined;
    reference_video_urls?: string[] | undefined;
    reference_audio_urls?: string[] | undefined;
    duration?: number | undefined;
    generate_audio?: boolean | undefined;
    web_search?: boolean | undefined;
    nsfw_checker?: boolean | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | "9:21" | "adaptive" | undefined;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "standard" | "fast" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    reference_image_urls?: string[] | undefined;
    reference_video_urls?: string[] | undefined;
    reference_audio_urls?: string[] | undefined;
    duration?: number | undefined;
    generate_audio?: boolean | undefined;
    web_search?: boolean | undefined;
    nsfw_checker?: boolean | undefined;
}>, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | "9:21" | "adaptive" | undefined;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "standard" | "fast" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    reference_image_urls?: string[] | undefined;
    reference_video_urls?: string[] | undefined;
    reference_audio_urls?: string[] | undefined;
    duration?: number | undefined;
    generate_audio?: boolean | undefined;
    web_search?: boolean | undefined;
    nsfw_checker?: boolean | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | "9:21" | "adaptive" | undefined;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "standard" | "fast" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    reference_image_urls?: string[] | undefined;
    reference_video_urls?: string[] | undefined;
    reference_audio_urls?: string[] | undefined;
    duration?: number | undefined;
    generate_audio?: boolean | undefined;
    web_search?: boolean | undefined;
    nsfw_checker?: boolean | undefined;
}>;
export declare const RunwayAlephVideoSchema: z.ZodObject<{
    prompt: z.ZodString;
    videoUrl: z.ZodString;
    waterMark: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    uploadCn: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    aspectRatio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"]>>>;
    seed: z.ZodOptional<z.ZodNumber>;
    referenceImage: z.ZodOptional<z.ZodString>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    videoUrl: string;
    aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    waterMark?: string | undefined;
    uploadCn?: boolean | undefined;
    seed?: number | undefined;
    referenceImage?: string | undefined;
}, {
    prompt: string;
    videoUrl: string;
    aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    waterMark?: string | undefined;
    uploadCn?: boolean | undefined;
    seed?: number | undefined;
    referenceImage?: string | undefined;
}>;
export declare const Wan27VideoSchema: z.ZodEffects<z.ZodObject<{
    mode: z.ZodOptional<z.ZodEnum<["text-to-video", "image-to-video", "reference-to-video", "video-edit"]>>;
    prompt: z.ZodString;
    negative_prompt: z.ZodOptional<z.ZodString>;
    audio_url: z.ZodOptional<z.ZodString>;
    first_frame_url: z.ZodOptional<z.ZodString>;
    last_frame_url: z.ZodOptional<z.ZodString>;
    first_clip_url: z.ZodOptional<z.ZodString>;
    driving_audio_url: z.ZodOptional<z.ZodString>;
    reference_image: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reference_video: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reference_voice: z.ZodOptional<z.ZodString>;
    first_frame: z.ZodOptional<z.ZodString>;
    video_url_edit: z.ZodOptional<z.ZodString>;
    reference_image_edit: z.ZodOptional<z.ZodString>;
    audio_setting: z.ZodOptional<z.ZodEnum<["auto", "origin"]>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["720p", "1080p"]>>>;
    ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["16:9", "9:16", "1:1", "4:3", "3:4"]>>>;
    duration: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    prompt_extend: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    watermark: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    seed: z.ZodOptional<z.ZodNumber>;
    nsfw_checker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    resolution?: "720p" | "1080p" | undefined;
    watermark?: boolean | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    duration?: number | undefined;
    nsfw_checker?: boolean | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    audio_url?: string | undefined;
    first_clip_url?: string | undefined;
    driving_audio_url?: string | undefined;
    reference_image?: string[] | undefined;
    reference_video?: string[] | undefined;
    reference_voice?: string | undefined;
    first_frame?: string | undefined;
    video_url_edit?: string | undefined;
    reference_image_edit?: string | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    prompt_extend?: boolean | undefined;
}, {
    prompt: string;
    resolution?: "720p" | "1080p" | undefined;
    watermark?: boolean | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    duration?: number | undefined;
    nsfw_checker?: boolean | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    audio_url?: string | undefined;
    first_clip_url?: string | undefined;
    driving_audio_url?: string | undefined;
    reference_image?: string[] | undefined;
    reference_video?: string[] | undefined;
    reference_voice?: string | undefined;
    first_frame?: string | undefined;
    video_url_edit?: string | undefined;
    reference_image_edit?: string | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    prompt_extend?: boolean | undefined;
}>, {
    prompt: string;
    resolution?: "720p" | "1080p" | undefined;
    watermark?: boolean | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    duration?: number | undefined;
    nsfw_checker?: boolean | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    audio_url?: string | undefined;
    first_clip_url?: string | undefined;
    driving_audio_url?: string | undefined;
    reference_image?: string[] | undefined;
    reference_video?: string[] | undefined;
    reference_voice?: string | undefined;
    first_frame?: string | undefined;
    video_url_edit?: string | undefined;
    reference_image_edit?: string | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    prompt_extend?: boolean | undefined;
}, {
    prompt: string;
    resolution?: "720p" | "1080p" | undefined;
    watermark?: boolean | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    first_frame_url?: string | undefined;
    last_frame_url?: string | undefined;
    duration?: number | undefined;
    nsfw_checker?: boolean | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    audio_url?: string | undefined;
    first_clip_url?: string | undefined;
    driving_audio_url?: string | undefined;
    reference_image?: string[] | undefined;
    reference_video?: string[] | undefined;
    reference_voice?: string | undefined;
    first_frame?: string | undefined;
    video_url_edit?: string | undefined;
    reference_image_edit?: string | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    prompt_extend?: boolean | undefined;
}>;
export declare const ByteDanceSeedreamImageSchema: z.ZodObject<{
    prompt: z.ZodString;
    image_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    version: z.ZodOptional<z.ZodDefault<z.ZodEnum<["4", "5-lite"]>>>;
    image_size: z.ZodOptional<z.ZodDefault<z.ZodEnum<["square", "square_hd", "portrait_4_3", "portrait_3_2", "portrait_16_9", "landscape_4_3", "landscape_3_2", "landscape_16_9", "landscape_21_9"]>>>;
    image_resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1K", "2K", "4K"]>>>;
    max_images: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    seed: z.ZodOptional<z.ZodNumber>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"]>>>;
    quality: z.ZodOptional<z.ZodDefault<z.ZodEnum<["basic", "high"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    image_urls?: string[] | undefined;
    version?: "4" | "5-lite" | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_3_2" | "portrait_16_9" | "landscape_4_3" | "landscape_3_2" | "landscape_16_9" | "landscape_21_9" | undefined;
    image_resolution?: "1K" | "2K" | "4K" | undefined;
    max_images?: number | undefined;
    quality?: "basic" | "high" | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    image_urls?: string[] | undefined;
    version?: "4" | "5-lite" | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_3_2" | "portrait_16_9" | "landscape_4_3" | "landscape_3_2" | "landscape_16_9" | "landscape_21_9" | undefined;
    image_resolution?: "1K" | "2K" | "4K" | undefined;
    max_images?: number | undefined;
    quality?: "basic" | "high" | undefined;
}>;
export declare const ZImageSchema: z.ZodObject<{
    prompt: z.ZodString;
    aspect_ratio: z.ZodDefault<z.ZodEnum<["1:1", "4:3", "3:4", "16:9", "9:16"]>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
    callBackUrl?: string | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    callBackUrl?: string | undefined;
}>;
export type ZImageRequest = z.infer<typeof ZImageSchema>;
export declare const GrokImagineSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodOptional<z.ZodString>;
    image_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    task_id: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodNumber>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["2:3", "3:2", "1:1"]>>>;
    mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["fun", "normal", "spicy"]>>>;
    generation_mode: z.ZodOptional<z.ZodEnum<["text-to-image", "text-to-video", "image-to-video", "upscale"]>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt?: string | undefined;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | undefined;
    callBackUrl?: string | undefined;
    mode?: "fun" | "normal" | "spicy" | undefined;
    image_urls?: string[] | undefined;
    task_id?: string | undefined;
    index?: number | undefined;
    generation_mode?: "text-to-video" | "image-to-video" | "text-to-image" | "upscale" | undefined;
}, {
    prompt?: string | undefined;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | undefined;
    callBackUrl?: string | undefined;
    mode?: "fun" | "normal" | "spicy" | undefined;
    image_urls?: string[] | undefined;
    task_id?: string | undefined;
    index?: number | undefined;
    generation_mode?: "text-to-video" | "image-to-video" | "text-to-image" | "upscale" | undefined;
}>, {
    prompt?: string | undefined;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | undefined;
    callBackUrl?: string | undefined;
    mode?: "fun" | "normal" | "spicy" | undefined;
    image_urls?: string[] | undefined;
    task_id?: string | undefined;
    index?: number | undefined;
    generation_mode?: "text-to-video" | "image-to-video" | "text-to-image" | "upscale" | undefined;
}, {
    prompt?: string | undefined;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | undefined;
    callBackUrl?: string | undefined;
    mode?: "fun" | "normal" | "spicy" | undefined;
    image_urls?: string[] | undefined;
    task_id?: string | undefined;
    index?: number | undefined;
    generation_mode?: "text-to-video" | "image-to-video" | "text-to-image" | "upscale" | undefined;
}>;
export type GrokImagineRequest = z.infer<typeof GrokImagineSchema>;
export declare const InfiniTalkSchema: z.ZodObject<{
    image_url: z.ZodString;
    audio_url: z.ZodString;
    prompt: z.ZodString;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["480p", "720p"]>>>;
    seed: z.ZodOptional<z.ZodNumber>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    audio_url: string;
    image_url: string;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
}, {
    prompt: string;
    audio_url: string;
    image_url: string;
    resolution?: "480p" | "720p" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
}>;
export type InfiniTalkRequest = z.infer<typeof InfiniTalkSchema>;
export declare const KlingAvatarSchema: z.ZodObject<{
    image_url: z.ZodString;
    audio_url: z.ZodString;
    prompt: z.ZodString;
    quality: z.ZodOptional<z.ZodDefault<z.ZodEnum<["standard", "pro"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    audio_url: string;
    image_url: string;
    callBackUrl?: string | undefined;
    quality?: "standard" | "pro" | undefined;
}, {
    prompt: string;
    audio_url: string;
    image_url: string;
    callBackUrl?: string | undefined;
    quality?: "standard" | "pro" | undefined;
}>;
export type KlingAvatarRequest = z.infer<typeof KlingAvatarSchema>;
export declare const HappyHorseVideoSchema: z.ZodEffects<z.ZodObject<{
    mode: z.ZodOptional<z.ZodEnum<["text-to-video", "image-to-video", "reference-to-video", "video-edit"]>>;
    prompt: z.ZodString;
    image_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reference_image: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    video_url: z.ZodOptional<z.ZodString>;
    reference_image_edit: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    audio_setting: z.ZodOptional<z.ZodEnum<["auto", "origin"]>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["720p", "1080p"]>>>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["16:9", "9:16", "1:1", "4:3", "3:4"]>>>;
    duration: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    seed: z.ZodOptional<z.ZodNumber>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    resolution?: "720p" | "1080p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    duration?: number | undefined;
    seed?: number | undefined;
    reference_image?: string[] | undefined;
    reference_image_edit?: string[] | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    image_urls?: string[] | undefined;
    video_url?: string | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    resolution?: "720p" | "1080p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    duration?: number | undefined;
    seed?: number | undefined;
    reference_image?: string[] | undefined;
    reference_image_edit?: string[] | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    image_urls?: string[] | undefined;
    video_url?: string | undefined;
}>, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    resolution?: "720p" | "1080p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    duration?: number | undefined;
    seed?: number | undefined;
    reference_image?: string[] | undefined;
    reference_image_edit?: string[] | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    image_urls?: string[] | undefined;
    video_url?: string | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined;
    resolution?: "720p" | "1080p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit" | undefined;
    duration?: number | undefined;
    seed?: number | undefined;
    reference_image?: string[] | undefined;
    reference_image_edit?: string[] | undefined;
    audio_setting?: "auto" | "origin" | undefined;
    image_urls?: string[] | undefined;
    video_url?: string | undefined;
}>;
export type HappyHorseVideoRequest = z.infer<typeof HappyHorseVideoSchema>;
export declare const QwenImageSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    image_url: z.ZodOptional<z.ZodString>;
    image_size: z.ZodOptional<z.ZodDefault<z.ZodEnum<["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"]>>>;
    num_inference_steps: z.ZodOptional<z.ZodNumber>;
    seed: z.ZodOptional<z.ZodNumber>;
    guidance_scale: z.ZodOptional<z.ZodNumber>;
    enable_safety_checker: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    output_format: z.ZodOptional<z.ZodDefault<z.ZodEnum<["png", "jpeg"]>>>;
    negative_prompt: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    acceleration: z.ZodOptional<z.ZodDefault<z.ZodEnum<["none", "regular", "high"]>>>;
    num_images: z.ZodOptional<z.ZodEnum<["1", "2", "3", "4"]>>;
    sync_mode: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    output_format?: "png" | "jpeg" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    image_url?: string | undefined;
    num_inference_steps?: number | undefined;
    guidance_scale?: number | undefined;
    enable_safety_checker?: boolean | undefined;
    acceleration?: "high" | "none" | "regular" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    sync_mode?: boolean | undefined;
}, {
    prompt: string;
    output_format?: "png" | "jpeg" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    image_url?: string | undefined;
    num_inference_steps?: number | undefined;
    guidance_scale?: number | undefined;
    enable_safety_checker?: boolean | undefined;
    acceleration?: "high" | "none" | "regular" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    sync_mode?: boolean | undefined;
}>, {
    prompt: string;
    output_format?: "png" | "jpeg" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    image_url?: string | undefined;
    num_inference_steps?: number | undefined;
    guidance_scale?: number | undefined;
    enable_safety_checker?: boolean | undefined;
    acceleration?: "high" | "none" | "regular" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    sync_mode?: boolean | undefined;
}, {
    prompt: string;
    output_format?: "png" | "jpeg" | undefined;
    callBackUrl?: string | undefined;
    seed?: number | undefined;
    negative_prompt?: string | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    image_url?: string | undefined;
    num_inference_steps?: number | undefined;
    guidance_scale?: number | undefined;
    enable_safety_checker?: boolean | undefined;
    acceleration?: "high" | "none" | "regular" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    sync_mode?: boolean | undefined;
}>;
export declare const MidjourneyGenerateSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    fileUrl: z.ZodOptional<z.ZodString>;
    fileUrls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    taskType: z.ZodOptional<z.ZodEnum<["mj_txt2img", "mj_img2img", "mj_style_reference", "mj_omni_reference", "mj_video", "mj_video_hd"]>>;
    aspectRatio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1:1", "9:16", "16:9", "4:3", "3:4", "21:9", "2:3", "3:2"]>>>;
    processMode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["relax", "fast"]>>>;
    weird: z.ZodOptional<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    seed: z.ZodOptional<z.ZodNumber>;
    stylize: z.ZodOptional<z.ZodNumber>;
    quality: z.ZodOptional<z.ZodNumber>;
    chaos: z.ZodOptional<z.ZodNumber>;
    repeat: z.ZodOptional<z.ZodNumber>;
    stop: z.ZodOptional<z.ZodNumber>;
    motion: z.ZodOptional<z.ZodNumber>;
    videoBatchSize: z.ZodOptional<z.ZodNumber>;
    high_definition_video: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    ow: z.ZodOptional<z.ZodString>;
    sref: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    speed: z.ZodOptional<z.ZodEnum<["relax", "fast", "turbo"]>>;
    variety: z.ZodOptional<z.ZodNumber>;
    stylization: z.ZodOptional<z.ZodNumber>;
    weirdness: z.ZodOptional<z.ZodNumber>;
    enableTranslation: z.ZodOptional<z.ZodBoolean>;
    waterMark: z.ZodOptional<z.ZodString>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspectRatio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    speed?: "turbo" | "fast" | "relax" | undefined;
    waterMark?: string | undefined;
    seed?: number | undefined;
    version?: string | undefined;
    quality?: number | undefined;
    fileUrl?: string | undefined;
    fileUrls?: string[] | undefined;
    taskType?: "mj_txt2img" | "mj_img2img" | "mj_style_reference" | "mj_omni_reference" | "mj_video" | "mj_video_hd" | undefined;
    processMode?: "fast" | "relax" | undefined;
    weird?: number | undefined;
    raw?: boolean | undefined;
    stylize?: number | undefined;
    chaos?: number | undefined;
    repeat?: number | undefined;
    stop?: number | undefined;
    motion?: number | undefined;
    videoBatchSize?: number | undefined;
    high_definition_video?: boolean | undefined;
    ow?: string | undefined;
    sref?: string | undefined;
    variety?: number | undefined;
    stylization?: number | undefined;
    weirdness?: number | undefined;
}, {
    prompt: string;
    aspectRatio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    speed?: "turbo" | "fast" | "relax" | undefined;
    waterMark?: string | undefined;
    seed?: number | undefined;
    version?: string | undefined;
    quality?: number | undefined;
    fileUrl?: string | undefined;
    fileUrls?: string[] | undefined;
    taskType?: "mj_txt2img" | "mj_img2img" | "mj_style_reference" | "mj_omni_reference" | "mj_video" | "mj_video_hd" | undefined;
    processMode?: "fast" | "relax" | undefined;
    weird?: number | undefined;
    raw?: boolean | undefined;
    stylize?: number | undefined;
    chaos?: number | undefined;
    repeat?: number | undefined;
    stop?: number | undefined;
    motion?: number | undefined;
    videoBatchSize?: number | undefined;
    high_definition_video?: boolean | undefined;
    ow?: string | undefined;
    sref?: string | undefined;
    variety?: number | undefined;
    stylization?: number | undefined;
    weirdness?: number | undefined;
}>, {
    prompt: string;
    aspectRatio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    speed?: "turbo" | "fast" | "relax" | undefined;
    waterMark?: string | undefined;
    seed?: number | undefined;
    version?: string | undefined;
    quality?: number | undefined;
    fileUrl?: string | undefined;
    fileUrls?: string[] | undefined;
    taskType?: "mj_txt2img" | "mj_img2img" | "mj_style_reference" | "mj_omni_reference" | "mj_video" | "mj_video_hd" | undefined;
    processMode?: "fast" | "relax" | undefined;
    weird?: number | undefined;
    raw?: boolean | undefined;
    stylize?: number | undefined;
    chaos?: number | undefined;
    repeat?: number | undefined;
    stop?: number | undefined;
    motion?: number | undefined;
    videoBatchSize?: number | undefined;
    high_definition_video?: boolean | undefined;
    ow?: string | undefined;
    sref?: string | undefined;
    variety?: number | undefined;
    stylization?: number | undefined;
    weirdness?: number | undefined;
}, {
    prompt: string;
    aspectRatio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    speed?: "turbo" | "fast" | "relax" | undefined;
    waterMark?: string | undefined;
    seed?: number | undefined;
    version?: string | undefined;
    quality?: number | undefined;
    fileUrl?: string | undefined;
    fileUrls?: string[] | undefined;
    taskType?: "mj_txt2img" | "mj_img2img" | "mj_style_reference" | "mj_omni_reference" | "mj_video" | "mj_video_hd" | undefined;
    processMode?: "fast" | "relax" | undefined;
    weird?: number | undefined;
    raw?: boolean | undefined;
    stylize?: number | undefined;
    chaos?: number | undefined;
    repeat?: number | undefined;
    stop?: number | undefined;
    motion?: number | undefined;
    videoBatchSize?: number | undefined;
    high_definition_video?: boolean | undefined;
    ow?: string | undefined;
    sref?: string | undefined;
    variety?: number | undefined;
    stylization?: number | undefined;
    weirdness?: number | undefined;
}>;
export declare const GptImage2Schema: z.ZodObject<{
    prompt: z.ZodString;
    input_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["auto", "1:1", "9:16", "16:9", "4:3", "3:4"]>>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1K", "2K", "4K"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | "4K" | undefined;
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
}>;
export type NanoBananaImageRequest = z.infer<typeof NanoBananaImageSchema>;
export type Veo3GenerateRequest = z.infer<typeof Veo3GenerateSchema>;
export type SunoGenerateRequest = z.infer<typeof SunoGenerateSchema>;
export type ElevenLabsTTSRequest = z.infer<typeof ElevenLabsTTSSchema>;
export type ElevenLabsSoundEffectsRequest = z.infer<typeof ElevenLabsSoundEffectsSchema>;
export type ByteDanceSeedanceVideoRequest = z.infer<typeof ByteDanceSeedanceVideoSchema>;
export type RunwayAlephVideoRequest = z.infer<typeof RunwayAlephVideoSchema>;
export type WanVideoRequest = z.infer<typeof Wan27VideoSchema>;
export type ByteDanceSeedreamImageRequest = z.infer<typeof ByteDanceSeedreamImageSchema>;
export type QwenImageRequest = z.infer<typeof QwenImageSchema>;
export type MidjourneyGenerateRequest = z.infer<typeof MidjourneyGenerateSchema>;
export type GptImage2Request = z.infer<typeof GptImage2Schema>;
export declare const FluxKontextImageSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    enableTranslation: z.ZodDefault<z.ZodBoolean>;
    uploadCn: z.ZodDefault<z.ZodBoolean>;
    inputImage: z.ZodOptional<z.ZodString>;
    aspectRatio: z.ZodDefault<z.ZodEnum<["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]>>;
    outputFormat: z.ZodDefault<z.ZodEnum<["jpeg", "png"]>>;
    promptUpsampling: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodDefault<z.ZodEnum<["flux-kontext-pro", "flux-kontext-max"]>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
    safetyTolerance: z.ZodDefault<z.ZodNumber>;
    watermark: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    model: "flux-kontext-pro" | "flux-kontext-max";
    aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9";
    enableTranslation: boolean;
    uploadCn: boolean;
    outputFormat: "png" | "jpeg";
    promptUpsampling: boolean;
    safetyTolerance: number;
    watermark?: string | undefined;
    callBackUrl?: string | undefined;
    inputImage?: string | undefined;
}, {
    prompt: string;
    model?: "flux-kontext-pro" | "flux-kontext-max" | undefined;
    watermark?: string | undefined;
    aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    uploadCn?: boolean | undefined;
    inputImage?: string | undefined;
    outputFormat?: "png" | "jpeg" | undefined;
    promptUpsampling?: boolean | undefined;
    safetyTolerance?: number | undefined;
}>, {
    prompt: string;
    model: "flux-kontext-pro" | "flux-kontext-max";
    aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9";
    enableTranslation: boolean;
    uploadCn: boolean;
    outputFormat: "png" | "jpeg";
    promptUpsampling: boolean;
    safetyTolerance: number;
    watermark?: string | undefined;
    callBackUrl?: string | undefined;
    inputImage?: string | undefined;
}, {
    prompt: string;
    model?: "flux-kontext-pro" | "flux-kontext-max" | undefined;
    watermark?: string | undefined;
    aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | undefined;
    callBackUrl?: string | undefined;
    enableTranslation?: boolean | undefined;
    uploadCn?: boolean | undefined;
    inputImage?: string | undefined;
    outputFormat?: "png" | "jpeg" | undefined;
    promptUpsampling?: boolean | undefined;
    safetyTolerance?: number | undefined;
}>;
export type FluxKontextImageRequest = z.infer<typeof FluxKontextImageSchema>;
export declare const TopazUpscaleImageSchema: z.ZodObject<{
    image_url: z.ZodString;
    upscale_factor: z.ZodDefault<z.ZodEnum<["1", "2", "4", "8"]>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    image_url: string;
    upscale_factor: "1" | "2" | "4" | "8";
    callBackUrl?: string | undefined;
}, {
    image_url: string;
    callBackUrl?: string | undefined;
    upscale_factor?: "1" | "2" | "4" | "8" | undefined;
}>;
export type TopazUpscaleImageRequest = z.infer<typeof TopazUpscaleImageSchema>;
export declare const RecraftRemoveBackgroundSchema: z.ZodEffects<z.ZodObject<{
    image: z.ZodString;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    image: string;
    callBackUrl?: string | undefined;
}, {
    image: string;
    callBackUrl?: string | undefined;
}>, {
    image: string;
    callBackUrl?: string | undefined;
}, {
    image: string;
    callBackUrl?: string | undefined;
}>;
export type RecraftRemoveBackgroundRequest = z.infer<typeof RecraftRemoveBackgroundSchema>;
export declare const IdeogramReframeSchema: z.ZodEffects<z.ZodObject<{
    image_url: z.ZodString;
    image_size: z.ZodDefault<z.ZodEnum<["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"]>>;
    rendering_speed: z.ZodOptional<z.ZodDefault<z.ZodEnum<["TURBO", "BALANCED", "QUALITY"]>>>;
    style: z.ZodOptional<z.ZodDefault<z.ZodEnum<["AUTO", "GENERAL", "REALISTIC", "DESIGN"]>>>;
    num_images: z.ZodOptional<z.ZodDefault<z.ZodEnum<["1", "2", "3", "4"]>>>;
    seed: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    image_size: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9";
    image_url: string;
    callBackUrl?: string | undefined;
    style?: "AUTO" | "GENERAL" | "REALISTIC" | "DESIGN" | undefined;
    seed?: number | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    rendering_speed?: "TURBO" | "BALANCED" | "QUALITY" | undefined;
}, {
    image_url: string;
    callBackUrl?: string | undefined;
    style?: "AUTO" | "GENERAL" | "REALISTIC" | "DESIGN" | undefined;
    seed?: number | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    rendering_speed?: "TURBO" | "BALANCED" | "QUALITY" | undefined;
}>, {
    image_size: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9";
    image_url: string;
    callBackUrl?: string | undefined;
    style?: "AUTO" | "GENERAL" | "REALISTIC" | "DESIGN" | undefined;
    seed?: number | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    rendering_speed?: "TURBO" | "BALANCED" | "QUALITY" | undefined;
}, {
    image_url: string;
    callBackUrl?: string | undefined;
    style?: "AUTO" | "GENERAL" | "REALISTIC" | "DESIGN" | undefined;
    seed?: number | undefined;
    image_size?: "square" | "square_hd" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9" | undefined;
    num_images?: "1" | "2" | "3" | "4" | undefined;
    rendering_speed?: "TURBO" | "BALANCED" | "QUALITY" | undefined;
}>;
export type IdeogramReframeRequest = z.infer<typeof IdeogramReframeSchema>;
export declare const KlingVideoSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    image_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    duration: z.ZodOptional<z.ZodDefault<z.ZodEffects<z.ZodString, string, string>>>;
    aspect_ratio: z.ZodOptional<z.ZodDefault<z.ZodEnum<["16:9", "9:16", "1:1"]>>>;
    mode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["std", "pro"]>>>;
    sound: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    multi_shots: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    multi_prompt: z.ZodOptional<z.ZodArray<z.ZodObject<{
        prompt: z.ZodString;
        duration: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        prompt: string;
        duration: number;
    }, {
        prompt: string;
        duration: number;
    }>, "many">>;
    kling_elements: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        element_input_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        element_input_video_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }, {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }>, "many">>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio?: "1:1" | "9:16" | "16:9" | undefined;
    callBackUrl?: string | undefined;
    mode?: "pro" | "std" | undefined;
    duration?: string | undefined;
    image_urls?: string[] | undefined;
    sound?: boolean | undefined;
    multi_shots?: boolean | undefined;
    multi_prompt?: {
        prompt: string;
        duration: number;
    }[] | undefined;
    kling_elements?: {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }[] | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "9:16" | "16:9" | undefined;
    callBackUrl?: string | undefined;
    mode?: "pro" | "std" | undefined;
    duration?: string | undefined;
    image_urls?: string[] | undefined;
    sound?: boolean | undefined;
    multi_shots?: boolean | undefined;
    multi_prompt?: {
        prompt: string;
        duration: number;
    }[] | undefined;
    kling_elements?: {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }[] | undefined;
}>, {
    prompt: string;
    aspect_ratio?: "1:1" | "9:16" | "16:9" | undefined;
    callBackUrl?: string | undefined;
    mode?: "pro" | "std" | undefined;
    duration?: string | undefined;
    image_urls?: string[] | undefined;
    sound?: boolean | undefined;
    multi_shots?: boolean | undefined;
    multi_prompt?: {
        prompt: string;
        duration: number;
    }[] | undefined;
    kling_elements?: {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }[] | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "9:16" | "16:9" | undefined;
    callBackUrl?: string | undefined;
    mode?: "pro" | "std" | undefined;
    duration?: string | undefined;
    image_urls?: string[] | undefined;
    sound?: boolean | undefined;
    multi_shots?: boolean | undefined;
    multi_prompt?: {
        prompt: string;
        duration: number;
    }[] | undefined;
    kling_elements?: {
        name: string;
        description: string;
        element_input_urls?: string[] | undefined;
        element_input_video_urls?: string[] | undefined;
    }[] | undefined;
}>;
export type KlingVideoRequest = z.infer<typeof KlingVideoSchema>;
export declare const HailuoVideoSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    imageUrl: z.ZodOptional<z.ZodString>;
    endImageUrl: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodDefault<z.ZodEnum<["02", "2.3"]>>>;
    quality: z.ZodOptional<z.ZodDefault<z.ZodEnum<["standard", "pro"]>>>;
    duration: z.ZodOptional<z.ZodDefault<z.ZodEnum<["6", "10"]>>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["512P", "768P", "1080P"]>>>;
    promptOptimizer: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    resolution?: "512P" | "768P" | "1080P" | undefined;
    callBackUrl?: string | undefined;
    duration?: "6" | "10" | undefined;
    version?: "02" | "2.3" | undefined;
    quality?: "standard" | "pro" | undefined;
    imageUrl?: string | undefined;
    endImageUrl?: string | undefined;
    promptOptimizer?: boolean | undefined;
}, {
    prompt: string;
    resolution?: "512P" | "768P" | "1080P" | undefined;
    callBackUrl?: string | undefined;
    duration?: "6" | "10" | undefined;
    version?: "02" | "2.3" | undefined;
    quality?: "standard" | "pro" | undefined;
    imageUrl?: string | undefined;
    endImageUrl?: string | undefined;
    promptOptimizer?: boolean | undefined;
}>, {
    prompt: string;
    resolution?: "512P" | "768P" | "1080P" | undefined;
    callBackUrl?: string | undefined;
    duration?: "6" | "10" | undefined;
    version?: "02" | "2.3" | undefined;
    quality?: "standard" | "pro" | undefined;
    imageUrl?: string | undefined;
    endImageUrl?: string | undefined;
    promptOptimizer?: boolean | undefined;
}, {
    prompt: string;
    resolution?: "512P" | "768P" | "1080P" | undefined;
    callBackUrl?: string | undefined;
    duration?: "6" | "10" | undefined;
    version?: "02" | "2.3" | undefined;
    quality?: "standard" | "pro" | undefined;
    imageUrl?: string | undefined;
    endImageUrl?: string | undefined;
    promptOptimizer?: boolean | undefined;
}>;
export type HailuoVideoRequest = z.infer<typeof HailuoVideoSchema>;
export declare const Flux2ImageSchema: z.ZodEffects<z.ZodObject<{
    prompt: z.ZodString;
    input_urls: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    aspect_ratio: z.ZodDefault<z.ZodEnum<["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"]>>;
    resolution: z.ZodDefault<z.ZodEnum<["1K", "2K"]>>;
    model_type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["pro", "flex"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    aspect_ratio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "auto";
    resolution: "1K" | "2K";
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
    model_type?: "pro" | "flex" | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | undefined;
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
    model_type?: "pro" | "flex" | undefined;
}>, {
    prompt: string;
    aspect_ratio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "auto";
    resolution: "1K" | "2K";
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
    model_type?: "pro" | "flex" | undefined;
}, {
    prompt: string;
    aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "auto" | undefined;
    resolution?: "1K" | "2K" | undefined;
    callBackUrl?: string | undefined;
    input_urls?: string[] | undefined;
    model_type?: "pro" | "flex" | undefined;
}>;
export type Flux2ImageRequest = z.infer<typeof Flux2ImageSchema>;
export declare const WanAnimateSchema: z.ZodObject<{
    video_url: z.ZodString;
    image_url: z.ZodString;
    mode: z.ZodDefault<z.ZodEnum<["animate", "replace"]>>;
    resolution: z.ZodOptional<z.ZodDefault<z.ZodEnum<["480p", "580p", "720p"]>>>;
    callBackUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    mode: "animate" | "replace";
    image_url: string;
    video_url: string;
    resolution?: "480p" | "720p" | "580p" | undefined;
    callBackUrl?: string | undefined;
}, {
    image_url: string;
    video_url: string;
    resolution?: "480p" | "720p" | "580p" | undefined;
    callBackUrl?: string | undefined;
    mode?: "animate" | "replace" | undefined;
}>;
export type WanAnimateRequest = z.infer<typeof WanAnimateSchema>;
export interface KieAiResponse<T = any> {
    code: number;
    msg: string;
    data?: T;
}
export interface ImageResponse {
    imageUrl?: string;
    taskId?: string;
}
export interface TaskResponse {
    taskId: string;
}
export interface TaskRecord {
    id?: number;
    task_id: string;
    api_type: "nano-banana" | "nano-banana-edit" | "nano-banana-image" | "veo3" | "suno" | "elevenlabs-tts" | "elevenlabs-sound-effects" | "bytedance-seedance-video" | "runway-aleph-video" | "wan-video" | "bytedance-seedream-image" | "qwen-image" | "midjourney" | "gpt-image-2" | "flux-kontext-image" | "recraft-remove-background" | "ideogram-reframe" | "kling-3.0-video" | "hailuo" | "flux2-image" | "wan-animate" | "z-image" | "grok-imagine" | "infinitalk" | "kling-avatar" | "topaz-upscale" | "happyhorse-video";
    status: "pending" | "processing" | "completed" | "failed";
    created_at: string;
    updated_at: string;
    result_url?: string;
    error_message?: string;
}
export interface KieAiConfig {
    apiKey: string;
    baseUrl: string;
    timeout: number;
    callbackUrlFallback: string;
}
