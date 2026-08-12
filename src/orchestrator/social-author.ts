/**
 * Independent social author identity for multi-author research gates.
 */

/**
 * Stable author key for one sealed inbox item.
 * Prefer clusterId, then a platform handle, then a bounded provenance slice.
 */
export function independentSocialAuthorKey(
  item: Readonly<{ provenance: string; clusterId?: string | undefined }>,
): string {
  if (item.clusterId && item.clusterId.trim()) {
    return `cluster:${item.clusterId.trim().toLowerCase()}`
  }
  const provenance = item.provenance.trim()
  const social = /^(twitter|farcaster|x|telegram):(@?[A-Za-z0-9_.-]+)/iu.exec(provenance)
  if (social?.[1] && social[2]) {
    return `${social[1].toLowerCase()}:${social[2].toLowerCase()}`
  }
  return `prov:${provenance.toLowerCase().slice(0, 120)}`
}
