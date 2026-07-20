#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/youtube.py

YouTube provider plug-in.

This provider uses the YouTube Data API v3 to discover and ingest public videos,
channels, and playlists relevant to biodiversity, taxonomy, conservation,
ecology, natural history, scientific institutions, field observations, lectures,
documentaries, and species education.

YouTube is not a taxonomic authority. Records are represented as
reference-oriented media entities through the shared Speciedex Taxon contract.
Taxonomic names detected in titles, descriptions, tags, and configured search
terms are retained as linkage candidates under
``Taxon.extra["taxonomic_mentions"]``.

The complete YouTube API objects are preserved under ``Taxon.extra["raw"]``.

Recommended providers.json configuration:

    {
        "name": "youtube",
        "module": "youtube",
        "enabled": true,
        "api_key": "${YOUTUBE_API_KEY}",
        "base_url": "https://www.googleapis.com/youtube/v3",
        "mode": "search",
        "query": "biodiversity taxonomy",
        "resource_type": "video",
        "order": "date",
        "published_after": "2020-01-01T00:00:00Z",
        "safe_search": "strict",
        "region_code": "US",
        "relevance_language": "en",
        "batch_size": 50,
        "hydrate_details": true,
        "extract_taxonomic_mentions": true
    }

Supported modes:

    search
        Search for videos, channels, or playlists.

    videos
        Retrieve explicit video IDs from ``video_ids``.

    channels
        Retrieve explicit channel IDs from ``channel_ids``.

    playlists
        Retrieve explicit playlist IDs from ``playlist_ids``.

The cursor is the opaque YouTube ``nextPageToken`` returned by the API.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import os
import re
from typing import Any, Iterable, Mapping

from .common import (
    BaseProvider,
    Batch,
    ProviderError,
    Taxon,
    normalize_space,
    now,
    safe_int,
)


_BINOMIAL_RE = re.compile(
    r"\b([A-Z][a-z]{2,})\s+([a-z][a-z-]{2,})\b"
)

_INFRASPECIFIC_RE = re.compile(
    r"\b([A-Z][a-z]{2,})\s+([a-z][a-z-]{2,})\s+"
    r"(?:(subsp|ssp|var|forma|f)\.?\s+)?([a-z][a-z-]{2,})\b"
)

_ISO8601_DURATION_RE = re.compile(
    r"^P"
    r"(?:(?P<days>\d+)D)?"
    r"(?:T"
    r"(?:(?P<hours>\d+)H)?"
    r"(?:(?P<minutes>\d+)M)?"
    r"(?:(?P<seconds>\d+)S)?"
    r")?$"
)

_EXCLUDED_SECOND_WORDS = {
    "academy",
    "analysis",
    "animals",
    "biodiversity",
    "biology",
    "channel",
    "conservation",
    "data",
    "documentary",
    "ecology",
    "education",
    "explained",
    "facts",
    "field",
    "guide",
    "history",
    "identification",
    "institute",
    "lecture",
    "nature",
    "network",
    "official",
    "research",
    "science",
    "species",
    "study",
    "taxonomy",
    "university",
    "video",
    "wildlife",
}


class Provider(BaseProvider):
    """HTTP-backed YouTube Data API provider."""

    PROVIDER_NAME = "youtube"

    DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3"
    MAX_PAGE_SIZE = 50

    def fetch(self) -> Batch:
        """Fetch and normalize one resumable YouTube API batch."""

        api_key = self._api_key()
        mode = normalize_space(
            self.definition.get("mode")
            or "search"
        ).casefold()

        if mode == "search":
            return self._fetch_search(api_key)

        if mode == "videos":
            return self._fetch_explicit_resources(
                api_key=api_key,
                endpoint="videos",
                configured_ids=self.definition.get("video_ids"),
                resource_type="video",
            )

        if mode == "channels":
            return self._fetch_explicit_resources(
                api_key=api_key,
                endpoint="channels",
                configured_ids=self.definition.get("channel_ids"),
                resource_type="channel",
            )

        if mode == "playlists":
            return self._fetch_explicit_resources(
                api_key=api_key,
                endpoint="playlists",
                configured_ids=self.definition.get("playlist_ids"),
                resource_type="playlist",
            )

        raise ProviderError(
            f"Unsupported YouTube provider mode: {mode!r}."
        )

    def _fetch_search(self, api_key: str) -> Batch:
        """Search YouTube and optionally hydrate matching resources."""

        base_url = self._base_url()
        page_size = self._page_size()
        page_token = normalize_space(self.cursor)

        query = normalize_space(
            self.definition.get("query")
            or self.definition.get("search")
        )

        if not query:
            raise ProviderError(
                "YouTube search mode requires query or search."
            )

        resource_type = normalize_space(
            self.definition.get("resource_type")
            or "video"
        ).casefold()

        if resource_type not in {"video", "channel", "playlist"}:
            raise ProviderError(
                "YouTube resource_type must be video, channel, or playlist."
            )

        params: dict[str, Any] = {
            "key": api_key,
            "part": "snippet",
            "q": query,
            "type": resource_type,
            "maxResults": page_size,
            "order": normalize_space(
                self.definition.get("order")
                or "relevance"
            ),
        }

        optional = {
            "channelId": "channel_id",
            "eventType": "event_type",
            "forContentOwner": "for_content_owner",
            "forDeveloper": "for_developer",
            "forMine": "for_mine",
            "location": "location",
            "locationRadius": "location_radius",
            "onBehalfOfContentOwner": "on_behalf_of_content_owner",
            "publishedAfter": "published_after",
            "publishedBefore": "published_before",
            "regionCode": "region_code",
            "relevanceLanguage": "relevance_language",
            "safeSearch": "safe_search",
            "topicId": "topic_id",
            "videoCaption": "video_caption",
            "videoCategoryId": "video_category_id",
            "videoDefinition": "video_definition",
            "videoDimension": "video_dimension",
            "videoDuration": "video_duration",
            "videoEmbeddable": "video_embeddable",
            "videoLicense": "video_license",
            "videoPaidProductPlacement": "video_paid_product_placement",
            "videoSyndicated": "video_syndicated",
            "videoType": "video_type",
        }

        for api_name, config_name in optional.items():
            value = self.definition.get(config_name)

            if value not in (None, "", [], {}):
                if isinstance(value, bool):
                    params[api_name] = str(value).lower()
                else:
                    params[api_name] = value

        if page_token:
            params["pageToken"] = page_token

        payload = self.http.get_json(
            f"{base_url}/search",
            params,
        )

        if not isinstance(payload, Mapping):
            raise ProviderError(
                "YouTube search returned a non-object response."
            )

        search_items = payload.get("items", [])

        if not isinstance(search_items, list):
            raise ProviderError(
                "YouTube search response has no valid items list."
            )

        hydrate = self._optional_bool(
            self.definition.get("hydrate_details")
        )

        if hydrate is None:
            hydrate = True

        hydrated: dict[str, dict[str, Any]] = {}

        if hydrate and search_items:
            hydrated = self._hydrate_search_results(
                api_key=api_key,
                resource_type=resource_type,
                search_items=search_items,
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for item in search_items:
            if not isinstance(item, Mapping):
                continue

            resource_id = self._search_resource_id(
                item,
                resource_type=resource_type,
            )

            detail = hydrated.get(resource_id, {})
            merged = self._merge_search_and_detail(
                search_item=item,
                detail_item=detail,
                resource_type=resource_type,
            )

            record = self._normalize_resource(
                merged,
                resource_type=resource_type,
                retrieved_at=retrieved_at,
                search_query=query,
            )

            if record is not None:
                records.append(record)

        next_cursor = normalize_space(
            payload.get("nextPageToken")
        )
        exhausted = not search_items or not next_cursor

        return Batch(
            records=records,
            next_cursor=None if exhausted else next_cursor,
            exhausted=exhausted,
            requests=2 if hydrated else 1,
            raw=len(search_items),
        )

    def _fetch_explicit_resources(
        self,
        *,
        api_key: str,
        endpoint: str,
        configured_ids: Any,
        resource_type: str,
    ) -> Batch:
        """Fetch explicit IDs in resumable local chunks."""

        identifiers = self._normalize_id_values(configured_ids)

        if not identifiers:
            raise ProviderError(
                f"YouTube {resource_type} mode requires configured IDs."
            )

        offset = self._decode_offset_cursor(self.cursor)
        page_size = self._page_size()
        chunk = identifiers[offset : offset + page_size]

        if not chunk:
            return Batch(
                records=[],
                next_cursor=None,
                exhausted=True,
                requests=0,
                raw=0,
            )

        params = {
            "key": api_key,
            "part": self._parts_for(resource_type),
            "id": ",".join(chunk),
            "maxResults": page_size,
        }

        payload = self.http.get_json(
            f"{self._base_url()}/{endpoint}",
            params,
        )

        if not isinstance(payload, Mapping):
            raise ProviderError(
                f"YouTube {endpoint} returned a non-object response."
            )

        items = payload.get("items", [])

        if not isinstance(items, list):
            raise ProviderError(
                f"YouTube {endpoint} response has no valid items list."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for item in items:
            if not isinstance(item, Mapping):
                continue

            record = self._normalize_resource(
                dict(item),
                resource_type=resource_type,
                retrieved_at=retrieved_at,
                search_query="",
            )

            if record is not None:
                records.append(record)

        next_offset = offset + len(chunk)
        exhausted = next_offset >= len(identifiers)

        return Batch(
            records=records,
            next_cursor=None if exhausted else str(next_offset),
            exhausted=exhausted,
            requests=1,
            raw=len(items),
        )

    def _hydrate_search_results(
        self,
        *,
        api_key: str,
        resource_type: str,
        search_items: list[Any],
    ) -> dict[str, dict[str, Any]]:
        """Hydrate search snippets with full resource details."""

        identifiers = [
            self._search_resource_id(
                item,
                resource_type=resource_type,
            )
            for item in search_items
            if isinstance(item, Mapping)
        ]
        identifiers = [
            identifier
            for identifier in identifiers
            if identifier
        ]

        if not identifiers:
            return {}

        endpoint = {
            "video": "videos",
            "channel": "channels",
            "playlist": "playlists",
        }[resource_type]

        payload = self.http.get_json(
            f"{self._base_url()}/{endpoint}",
            {
                "key": api_key,
                "part": self._parts_for(resource_type),
                "id": ",".join(identifiers),
                "maxResults": min(
                    len(identifiers),
                    self.MAX_PAGE_SIZE,
                ),
            },
        )

        if not isinstance(payload, Mapping):
            return {}

        items = payload.get("items", [])

        if not isinstance(items, list):
            return {}

        result: dict[str, dict[str, Any]] = {}

        for item in items:
            if not isinstance(item, Mapping):
                continue

            identifier = normalize_space(item.get("id"))

            if identifier:
                result[identifier] = dict(item)

        return result

    def _normalize_resource(
        self,
        raw: dict[str, Any],
        *,
        resource_type: str,
        retrieved_at: str,
        search_query: str,
    ) -> Taxon | None:
        """Normalize one video, channel, or playlist."""

        provider_id = normalize_space(raw.get("id"))
        snippet = raw.get("snippet", {})
        snippet = snippet if isinstance(snippet, Mapping) else {}

        title = normalize_space(snippet.get("title"))

        if not provider_id or not title:
            return None

        description = normalize_space(
            snippet.get("description")
        )
        tags = [
            normalize_space(tag)
            for tag in self._list_value(
                snippet.get("tags")
            )
            if normalize_space(tag)
        ]

        mentions = self._extract_taxonomic_mentions(
            title=title,
            description=description,
            tags=tags,
            search_query=search_query,
        )

        primary_linkage = (
            mentions[0]["scientific_name"]
            if mentions
            else title
        )

        source_url = self._resource_url(
            provider_id,
            resource_type=resource_type,
        )

        status = self._resource_status(raw)

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=primary_linkage,
            canonical_name=primary_linkage,
            rank=(
                self._infer_taxonomic_rank(primary_linkage)
                if mentions
                else f"youtube_{resource_type}"
            ),
            status=status,
            authorship=normalize_space(
                snippet.get("channelTitle")
            ),
            kingdom="",
            phylum="",
            class_name="",
            order="",
            family="",
            genus=self._infer_genus(primary_linkage),
            accepted_provider_id="",
            source_url=source_url,
            source_modified=normalize_space(
                self._first_value(
                    raw,
                    "updatedAt",
                    "modifiedAt",
                    "publishedAt",
                )
            ),
            retrieved_at=retrieved_at,
            synonyms=[],
            extra={
                "source": "YouTube",
                "programme": "youtube",
                "reference_only": True,
                "entity_type": f"youtube_{resource_type}",
                "youtube_id": provider_id,
                "resource_type": resource_type,
                "title": title,
                "description": description,
                "published_at": normalize_space(
                    snippet.get("publishedAt")
                ),
                "channel": {
                    "channel_id": normalize_space(
                        snippet.get("channelId")
                    ),
                    "channel_title": normalize_space(
                        snippet.get("channelTitle")
                    ),
                    "custom_url": normalize_space(
                        self._nested_value(
                            raw,
                            "snippet",
                            "customUrl",
                        )
                    ),
                    "country": normalize_space(
                        self._nested_value(
                            raw,
                            "snippet",
                            "country",
                        )
                    ),
                },
                "language": {
                    "default_language": normalize_space(
                        snippet.get("defaultLanguage")
                    ),
                    "default_audio_language": normalize_space(
                        snippet.get("defaultAudioLanguage")
                    ),
                    "relevance_language": normalize_space(
                        self.definition.get(
                            "relevance_language"
                        )
                    ),
                },
                "tags": tags,
                "category_id": normalize_space(
                    snippet.get("categoryId")
                ),
                "live_broadcast_content": normalize_space(
                    snippet.get("liveBroadcastContent")
                ),
                "thumbnails": self._normalize_thumbnails(
                    snippet.get("thumbnails")
                ),
                "video": (
                    self._normalize_video(raw)
                    if resource_type == "video"
                    else {}
                ),
                "channel_details": (
                    self._normalize_channel(raw)
                    if resource_type == "channel"
                    else {}
                ),
                "playlist": (
                    self._normalize_playlist(raw)
                    if resource_type == "playlist"
                    else {}
                ),
                "statistics": self._normalize_statistics(
                    raw.get("statistics")
                ),
                "content_owner": self._normalize_content_owner(
                    raw.get("contentOwnerDetails")
                ),
                "branding": self._normalize_mapping(
                    raw.get("brandingSettings")
                ),
                "topic_details": self._normalize_topic_details(
                    raw.get("topicDetails")
                ),
                "localizations": self._normalize_localizations(
                    raw.get("localizations")
                ),
                "taxonomic_mentions": mentions,
                "search": {
                    "query": search_query,
                    "order": normalize_space(
                        self.definition.get("order")
                    ),
                    "region_code": normalize_space(
                        self.definition.get("region_code")
                    ),
                    "safe_search": normalize_space(
                        self.definition.get("safe_search")
                    ),
                },
                "rights": {
                    "licensed_content": self._optional_bool(
                        self._nested_value(
                            raw,
                            "contentDetails",
                            "licensedContent",
                        )
                    ),
                    "license": normalize_space(
                        self._first_value(
                            raw,
                            "license",
                            "videoLicense",
                        )
                    ),
                    "embeddable": self._optional_bool(
                        self._nested_value(
                            raw,
                            "status",
                            "embeddable",
                        )
                    ),
                    "privacy_status": normalize_space(
                        self._nested_value(
                            raw,
                            "status",
                            "privacyStatus",
                        )
                    ),
                    "made_for_kids": self._optional_bool(
                        raw.get("madeForKids")
                    ),
                    "self_declared_made_for_kids": (
                        self._optional_bool(
                            raw.get(
                                "selfDeclaredMadeForKids"
                            )
                        )
                    ),
                },
                "identifiers": [
                    {
                        "source": "YouTube",
                        "identifier": provider_id,
                    },
                    {
                        "source": "YouTube Channel",
                        "identifier": normalize_space(
                            snippet.get("channelId")
                        ),
                    },
                ],
                "links": [
                    {
                        "relation": resource_type,
                        "url": source_url,
                    },
                    {
                        "relation": "channel",
                        "url": self._resource_url(
                            normalize_space(
                                snippet.get("channelId")
                            ),
                            resource_type="channel",
                        ),
                    },
                ],
                "raw": raw,
            },
        )

    @classmethod
    def _normalize_video(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        content = raw.get("contentDetails", {})
        content = content if isinstance(content, Mapping) else {}

        status = raw.get("status", {})
        status = status if isinstance(status, Mapping) else {}

        live = raw.get("liveStreamingDetails", {})
        live = live if isinstance(live, Mapping) else {}

        recording = raw.get("recordingDetails", {})
        recording = recording if isinstance(recording, Mapping) else {}

        duration = normalize_space(content.get("duration"))

        return {
            "duration": duration,
            "duration_seconds": cls._parse_duration_seconds(
                duration
            ),
            "dimension": normalize_space(
                content.get("dimension")
            ),
            "definition": normalize_space(
                content.get("definition")
            ),
            "caption": cls._optional_bool(
                content.get("caption")
            ),
            "licensed_content": cls._optional_bool(
                content.get("licensedContent")
            ),
            "projection": normalize_space(
                content.get("projection")
            ),
            "region_restriction": cls._normalize_mapping(
                content.get("regionRestriction")
            ),
            "content_rating": cls._normalize_mapping(
                content.get("contentRating")
            ),
            "privacy_status": normalize_space(
                status.get("privacyStatus")
            ),
            "upload_status": normalize_space(
                status.get("uploadStatus")
            ),
            "failure_reason": normalize_space(
                status.get("failureReason")
            ),
            "rejection_reason": normalize_space(
                status.get("rejectionReason")
            ),
            "license": normalize_space(
                status.get("license")
            ),
            "embeddable": cls._optional_bool(
                status.get("embeddable")
            ),
            "public_stats_viewable": cls._optional_bool(
                status.get("publicStatsViewable")
            ),
            "actual_start_time": normalize_space(
                live.get("actualStartTime")
            ),
            "actual_end_time": normalize_space(
                live.get("actualEndTime")
            ),
            "scheduled_start_time": normalize_space(
                live.get("scheduledStartTime")
            ),
            "scheduled_end_time": normalize_space(
                live.get("scheduledEndTime")
            ),
            "concurrent_viewers": cls._optional_int(
                live.get("concurrentViewers")
            ),
            "recording_date": normalize_space(
                recording.get("recordingDate")
            ),
            "recording_location": cls._normalize_mapping(
                recording.get("location")
            ),
        }

    @classmethod
    def _normalize_channel(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        content = raw.get("contentDetails", {})
        content = content if isinstance(content, Mapping) else {}

        audit = raw.get("auditDetails", {})
        audit = audit if isinstance(audit, Mapping) else {}

        return {
            "related_playlists": cls._normalize_mapping(
                content.get("relatedPlaylists")
            ),
            "status": cls._normalize_mapping(
                raw.get("status")
            ),
            "audit_details": {
                "overall_good_standing": cls._optional_bool(
                    audit.get("overallGoodStanding")
                ),
                "community_guidelines_good_standing": (
                    cls._optional_bool(
                        audit.get(
                            "communityGuidelinesGoodStanding"
                        )
                    )
                ),
                "copyright_strikes_good_standing": (
                    cls._optional_bool(
                        audit.get(
                            "copyrightStrikesGoodStanding"
                        )
                    )
                ),
                "content_id_claims_good_standing": (
                    cls._optional_bool(
                        audit.get(
                            "contentIdClaimsGoodStanding"
                        )
                    )
                ),
            },
        }

    @classmethod
    def _normalize_playlist(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        content = raw.get("contentDetails", {})
        content = content if isinstance(content, Mapping) else {}

        status = raw.get("status", {})
        status = status if isinstance(status, Mapping) else {}

        player = raw.get("player", {})
        player = player if isinstance(player, Mapping) else {}

        return {
            "item_count": cls._optional_int(
                content.get("itemCount")
            ),
            "privacy_status": normalize_space(
                status.get("privacyStatus")
            ),
            "embed_html": normalize_space(
                player.get("embedHtml")
            ),
        }

    @classmethod
    def _normalize_statistics(
        cls,
        value: Any,
    ) -> dict[str, int | None]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "view_count": cls._optional_int(
                value.get("viewCount")
            ),
            "like_count": cls._optional_int(
                value.get("likeCount")
            ),
            "dislike_count": cls._optional_int(
                value.get("dislikeCount")
            ),
            "favorite_count": cls._optional_int(
                value.get("favoriteCount")
            ),
            "comment_count": cls._optional_int(
                value.get("commentCount")
            ),
            "subscriber_count": cls._optional_int(
                value.get("subscriberCount")
            ),
            "hidden_subscriber_count": cls._optional_bool(
                value.get("hiddenSubscriberCount")
            ),
            "video_count": cls._optional_int(
                value.get("videoCount")
            ),
        }

    @classmethod
    def _normalize_content_owner(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "content_owner": normalize_space(
                value.get("contentOwner")
            ),
            "time_linked": normalize_space(
                value.get("timeLinked")
            ),
        }

    @classmethod
    def _normalize_topic_details(
        cls,
        value: Any,
    ) -> dict[str, list[str]]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "topic_ids": [
                normalize_space(item)
                for item in cls._list_value(
                    value.get("topicIds")
                )
                if normalize_space(item)
            ],
            "topic_categories": [
                normalize_space(item)
                for item in cls._list_value(
                    value.get("topicCategories")
                )
                if normalize_space(item)
            ],
        }

    @classmethod
    def _normalize_localizations(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        if not isinstance(value, Mapping):
            return []

        result: list[dict[str, str]] = []

        for language, localization in value.items():
            if not isinstance(localization, Mapping):
                continue

            result.append(
                {
                    "language": normalize_space(language),
                    "title": normalize_space(
                        localization.get("title")
                    ),
                    "description": normalize_space(
                        localization.get("description")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_thumbnails(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        if not isinstance(value, Mapping):
            return []

        result: list[dict[str, Any]] = []

        for size, thumbnail in value.items():
            if not isinstance(thumbnail, Mapping):
                continue

            url = normalize_space(thumbnail.get("url"))

            if not url:
                continue

            result.append(
                {
                    "size": normalize_space(size),
                    "url": url,
                    "width": cls._optional_int(
                        thumbnail.get("width")
                    ),
                    "height": cls._optional_int(
                        thumbnail.get("height")
                    ),
                }
            )

        return result

    @classmethod
    def _extract_taxonomic_mentions(
        cls,
        *,
        title: str,
        description: str,
        tags: Iterable[str],
        search_query: str,
    ) -> list[dict[str, Any]]:
        """Extract plausible Latin binomials and infraspecific names."""

        text = " ".join(
            part
            for part in (
                title,
                description,
                " ".join(tags),
                search_query,
            )
            if part
        )

        result: list[dict[str, Any]] = []
        seen: set[str] = set()

        for match in _INFRASPECIFIC_RE.finditer(text):
            genus, species, marker, infra = match.groups()

            if species.casefold() in _EXCLUDED_SECOND_WORDS:
                continue

            scientific_name = (
                f"{genus} {species} "
                f"{(marker + '. ') if marker else ''}{infra}"
            ).strip()
            key = scientific_name.casefold()

            if key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "scientific_name": scientific_name,
                    "canonical_name": (
                        f"{genus} {species} {infra}"
                    ),
                    "rank": "infraspecific",
                    "genus": genus,
                    "specific_epithet": species,
                    "infraspecific_epithet": infra,
                    "match_type": "trinomial",
                }
            )

        for match in _BINOMIAL_RE.finditer(text):
            genus, species = match.groups()

            if species.casefold() in _EXCLUDED_SECOND_WORDS:
                continue

            scientific_name = f"{genus} {species}"
            key = scientific_name.casefold()

            if key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "scientific_name": scientific_name,
                    "canonical_name": scientific_name,
                    "rank": "species",
                    "genus": genus,
                    "specific_epithet": species,
                    "infraspecific_epithet": "",
                    "match_type": "binomial",
                }
            )

        return result

    @staticmethod
    def _resource_status(raw: Mapping[str, Any]) -> str:
        privacy = normalize_space(
            Provider._nested_value(
                raw,
                "status",
                "privacyStatus",
            )
        ).casefold()
        upload = normalize_space(
            Provider._nested_value(
                raw,
                "status",
                "uploadStatus",
            )
        ).casefold()

        if privacy == "public" and upload in {"", "processed", "uploaded"}:
            return "reference"

        if privacy in {"private", "unlisted"}:
            return "inactive"

        if upload in {"failed", "rejected", "deleted"}:
            return "inactive"

        return "reference"

    @staticmethod
    def _parts_for(resource_type: str) -> str:
        return {
            "video": (
                "snippet,contentDetails,statistics,status,"
                "recordingDetails,liveStreamingDetails,"
                "topicDetails,localizations"
            ),
            "channel": (
                "snippet,contentDetails,statistics,status,"
                "brandingSettings,topicDetails,localizations"
            ),
            "playlist": (
                "snippet,contentDetails,status,player,"
                "localizations"
            ),
        }[resource_type]

    @staticmethod
    def _search_resource_id(
        item: Mapping[str, Any],
        *,
        resource_type: str,
    ) -> str:
        identifier = item.get("id", {})

        if not isinstance(identifier, Mapping):
            return normalize_space(identifier)

        key = {
            "video": "videoId",
            "channel": "channelId",
            "playlist": "playlistId",
        }[resource_type]

        return normalize_space(identifier.get(key))

    @staticmethod
    def _merge_search_and_detail(
        *,
        search_item: Mapping[str, Any],
        detail_item: Mapping[str, Any],
        resource_type: str,
    ) -> dict[str, Any]:
        merged = dict(detail_item)

        if not merged:
            merged = dict(search_item)
            merged["id"] = Provider._search_resource_id(
                search_item,
                resource_type=resource_type,
            )

        search_snippet = search_item.get("snippet", {})
        detail_snippet = merged.get("snippet", {})

        if isinstance(search_snippet, Mapping):
            combined_snippet = dict(search_snippet)

            if isinstance(detail_snippet, Mapping):
                combined_snippet.update(detail_snippet)

            merged["snippet"] = combined_snippet

        merged["_search_result"] = dict(search_item)
        return merged

    @staticmethod
    def _resource_url(
        identifier: str,
        *,
        resource_type: str,
    ) -> str:
        identifier = normalize_space(identifier)

        if not identifier:
            return ""

        if resource_type == "video":
            return f"https://www.youtube.com/watch?v={identifier}"

        if resource_type == "channel":
            return f"https://www.youtube.com/channel/{identifier}"

        if resource_type == "playlist":
            return f"https://www.youtube.com/playlist?list={identifier}"

        return ""

    def _api_key(self) -> str:
        configured = normalize_space(
            self.definition.get("api_key")
        )

        if configured.startswith("${") and configured.endswith("}"):
            configured = normalize_space(
                os.environ.get(configured[2:-1])
            )

        key = (
            configured
            or normalize_space(
                os.environ.get("YOUTUBE_API_KEY")
            )
            or normalize_space(
                os.environ.get("GOOGLE_API_KEY")
            )
        )

        if not key:
            raise ProviderError(
                "YouTube provider requires api_key, "
                "YOUTUBE_API_KEY, or GOOGLE_API_KEY."
            )

        return key

    def _base_url(self) -> str:
        return normalize_space(
            self.definition.get("base_url")
            or self.DEFAULT_BASE_URL
        ).rstrip("/")

    def _page_size(self) -> int:
        configured = safe_int(
            self.definition.get(
                "max_results",
                self.definition.get(
                    "page_size",
                    self.batch_size,
                ),
            ),
            self.batch_size,
        )
        return min(
            max(1, configured),
            self.MAX_PAGE_SIZE,
        )

    @staticmethod
    def _normalize_id_values(value: Any) -> list[str]:
        if value is None:
            return []

        if isinstance(value, str):
            candidates = re.split(r"[\s,|]+", value)
        elif isinstance(value, (list, tuple, set)):
            candidates = list(value)
        else:
            candidates = [value]

        result: list[str] = []
        seen: set[str] = set()

        for candidate in candidates:
            identifier = normalize_space(candidate)
            key = identifier.casefold()

            if not identifier or key in seen:
                continue

            seen.add(key)
            result.append(identifier)

        return result

    @staticmethod
    def _parse_duration_seconds(value: str) -> int | None:
        match = _ISO8601_DURATION_RE.match(
            normalize_space(value)
        )

        if not match:
            return None

        days = int(match.group("days") or 0)
        hours = int(match.group("hours") or 0)
        minutes = int(match.group("minutes") or 0)
        seconds = int(match.group("seconds") or 0)

        return (
            days * 86400
            + hours * 3600
            + minutes * 60
            + seconds
        )

    @staticmethod
    def _infer_taxonomic_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(scientific_name).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "infraspecific"

        return "unknown"

    @staticmethod
    def _infer_genus(
        scientific_name: str,
    ) -> str:
        words = normalize_space(scientific_name).split()

        if (
            len(words) >= 2
            and words[0][:1].isupper()
            and words[0][1:].islower()
        ):
            return words[0]

        return ""

    @staticmethod
    def _decode_offset_cursor(cursor: str | None) -> int:
        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid YouTube offset cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "YouTube offset cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _nested_value(
        record: Mapping[str, Any],
        *keys: str,
    ) -> Any:
        value: Any = record

        for key in keys:
            if not isinstance(value, Mapping):
                return None

            value = value.get(key)

        return value

    @staticmethod
    def _first_value(
        record: Mapping[str, Any],
        *keys: str,
    ) -> Any:
        for key in keys:
            value = record.get(key)

            if value not in (
                None,
                "",
                [],
                {},
            ):
                return value

        return None

    @staticmethod
    def _list_value(value: Any) -> list[Any]:
        if value is None:
            return []

        if isinstance(value, list):
            return value

        if isinstance(value, tuple):
            return list(value)

        if isinstance(value, set):
            return list(value)

        return [value]

    @staticmethod
    def _normalize_mapping(
        value: Any,
    ) -> dict[str, Any]:
        return dict(value) if isinstance(value, Mapping) else {}

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value in (None, ""):
            return None

        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_bool(value: Any) -> bool | None:
        if isinstance(value, bool):
            return value

        if isinstance(value, int):
            return bool(value)

        normalized = normalize_space(value).casefold()

        if normalized in {
            "1",
            "true",
            "yes",
            "y",
            "present",
            "public",
            "processed",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "private",
            "failed",
        }:
            return False

        return None
